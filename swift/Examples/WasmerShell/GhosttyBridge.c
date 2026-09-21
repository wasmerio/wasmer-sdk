#include "GhosttyBridge.h"
#include <ghostty/vt.h>
#include <stdlib.h>
#include <string.h>

struct WTTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder encoder;
  GhosttyKeyEvent event;
  GhosttyRenderStateColors colors;
  GhosttyBuffer text;
  int row, column;
  bool in_row;
  uint8_t response[65536];
  size_t response_length;
};

static uint32_t rgb(GhosttyColorRgb c) { return ((uint32_t)c.r << 16) | ((uint32_t)c.g << 8) | c.b; }
static GhosttyColorRgb color(GhosttyStyleColor c, const GhosttyRenderStateColors *colors, GhosttyColorRgb fallback) {
  if (c.tag == GHOSTTY_STYLE_COLOR_RGB) return c.value.rgb;
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) return colors->palette[c.value.palette];
  return fallback;
}
static void reply(GhosttyTerminal terminal, void *userdata, const uint8_t *bytes, size_t length) {
  (void)terminal;
  WTTerminal *t = userdata;
  size_t available = sizeof(t->response) - t->response_length;
  if (length > available) length = available;
  memcpy(t->response + t->response_length, bytes, length);
  t->response_length += length;
}

WTTerminal *wt_new(uint16_t columns, uint16_t rows) {
  WTTerminal *t = calloc(1, sizeof(*t));
  if (!t) return NULL;
  if (ghostty_terminal_new(NULL, &t->terminal, columns, rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &t->render) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &t->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &t->cells) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(NULL, &t->encoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &t->event) != GHOSTTY_SUCCESS) {
    wt_free(t); return NULL;
  }
  // Match the xterm theme in wasmer-sh/src/main.ts, including ANSI colors.
  GhosttyColorRgb fg = {0xe8, 0xe5, 0xed}, bg = {0x0c, 0x0c, 0x12};
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &fg);
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &bg);
  GhosttyColorRgb palette[256];
  ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE, &palette);
  const GhosttyColorRgb ansi[] = {
    {0x17, 0x17, 0x1f}, {0xfb, 0x71, 0x85}, {0x5e, 0xe6, 0xa8}, {0xfa, 0xcc, 0x6b},
    {0x81, 0xae, 0xfc}, {0xc4, 0xa7, 0xff}, {0x67, 0xe8, 0xf9}, {0xe8, 0xe5, 0xed},
    {0x69, 0x65, 0x75}, {0xfd, 0xa4, 0xaf}, {0x86, 0xef, 0xc0}, {0xfd, 0xe6, 0x8a},
    {0xa9, 0xc7, 0xff}, {0xdd, 0xd0, 0xff}, {0xa5, 0xf3, 0xfc}, {0xff, 0xff, 0xff},
  };
  memcpy(palette, ansi, sizeof(ansi));
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, &palette);
  size_t scrollback = 4 * 1024 * 1024;
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &scrollback);
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, t);
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void *)reply);
  // WASIX output pipes carry LF without a host PTY's ONLCR conversion.
  GhosttyTerminalModeConfig newline_mode = { .mode = GHOSTTY_MODE_LINEFEED, .value = true };
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &newline_mode);
  return t;
}
void wt_free(WTTerminal *t) {
  if (!t) return;
  ghostty_key_event_free(t->event);
  ghostty_key_encoder_free(t->encoder);
  ghostty_render_state_row_cells_free(t->cells);
  ghostty_render_state_row_iterator_free(t->rows);
  ghostty_render_state_free(t->render);
  ghostty_terminal_free(t->terminal);
  free(t->text.ptr);
  free(t);
}
void wt_feed(WTTerminal *t, const uint8_t *bytes, size_t length) {
  ghostty_terminal_vt_write(t->terminal, bytes, length);
}
bool wt_resize(WTTerminal *t, uint16_t columns, uint16_t rows) {
  return ghostty_terminal_resize(t->terminal, columns, rows, 0, 0) == GHOSTTY_SUCCESS;
}
void wt_scroll(WTTerminal *t, int delta) {
  ghostty_terminal_scroll_viewport(t->terminal, (GhosttyTerminalScrollViewport){
    .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA, .value.delta = delta });
}
void wt_bottom(WTTerminal *t) {
  ghostty_terminal_scroll_viewport(t->terminal, (GhosttyTerminalScrollViewport){ .tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM });
}
bool wt_begin_frame(WTTerminal *t, WTFrame *frame) {
  if (ghostty_render_state_update(t->render, t->terminal) != GHOSTTY_SUCCESS) return false;
  t->colors = (GhosttyRenderStateColors)GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  ghostty_render_state_get(t->render, GHOSTTY_RENDER_STATE_DATA_COLORS, &t->colors);
  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(t->render, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  *frame = (WTFrame){ .column = cursor.viewport_x, .row = cursor.viewport_y,
    .visible = cursor.visible && cursor.viewport_has_value,
    .foreground = rgb(t->colors.foreground), .background = rgb(t->colors.background) };
  ghostty_render_state_get(t->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &t->rows);
  t->row = -1; t->column = 0; t->in_row = false;
  ghostty_render_state_clean(t->render);
  return true;
}
bool wt_next_cell(WTTerminal *t, WTCell *out) {
  while (!t->in_row || !ghostty_render_state_row_cells_next(t->cells)) {
    if (!ghostty_render_state_row_iterator_next(t->rows)) return false;
    t->row++; t->column = 0; t->in_row = true;
    if (ghostty_render_state_row_get(t->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &t->cells) != GHOSTTY_SUCCESS) return false;
  }
  GhosttyResult result = ghostty_render_state_row_cells_get(t->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &t->text);
  if (result == GHOSTTY_OUT_OF_SPACE) {
    uint8_t *bytes = realloc(t->text.ptr, t->text.len);
    if (!bytes) return false;
    t->text.ptr = bytes; t->text.cap = t->text.len;
    result = ghostty_render_state_row_cells_get(t->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &t->text);
  }
  if (result != GHOSTTY_SUCCESS) return false;
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  ghostty_render_state_row_cells_get(t->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
  GhosttyColorRgb fg = color(style.fg_color, &t->colors, t->colors.foreground);
  GhosttyColorRgb bg = color(style.bg_color, &t->colors, t->colors.background);
  if (style.inverse) { GhosttyColorRgb swap = fg; fg = bg; bg = swap; }
  if (style.invisible) fg = bg;
  if (style.faint) { fg.r /= 2; fg.g /= 2; fg.b /= 2; }
  GhosttyCell raw;
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  ghostty_render_state_row_cells_get(t->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
  *out = (WTCell){ .column = t->column++, .row = t->row, .text = t->text.ptr, .length = t->text.len,
    .foreground = rgb(fg), .background = rgb(bg), .bold = style.bold, .italic = style.italic,
    .underline = style.underline != 0, .strike = style.strikethrough,
    .width = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : wide == GHOSTTY_CELL_WIDE_NARROW ? 1 : 0 };
  return true;
}
size_t wt_take_response(WTTerminal *t, uint8_t *bytes, size_t capacity) {
  size_t count = t->response_length < capacity ? t->response_length : capacity;
  memcpy(bytes, t->response, count);
  memmove(t->response, t->response + count, t->response_length - count);
  t->response_length -= count;
  return count;
}
size_t wt_key(WTTerminal *t, int key, uint8_t *bytes, size_t capacity) {
  const GhosttyKey keys[] = {GHOSTTY_KEY_ARROW_UP, GHOSTTY_KEY_ARROW_DOWN, GHOSTTY_KEY_ARROW_LEFT,
    GHOSTTY_KEY_ARROW_RIGHT, GHOSTTY_KEY_BACKSPACE, GHOSTTY_KEY_ENTER, GHOSTTY_KEY_TAB, GHOSTTY_KEY_ESCAPE};
  if (key < 0 || key >= (int)(sizeof(keys) / sizeof(keys[0]))) return 0;
  ghostty_key_encoder_setopt_from_terminal(t->encoder, t->terminal);
  ghostty_key_event_set_action(t->event, GHOSTTY_KEY_ACTION_PRESS);
  ghostty_key_event_set_key(t->event, keys[key]);
  size_t length = 0;
  if (ghostty_key_encoder_encode(t->encoder, t->event, (char *)bytes, capacity, &length) != GHOSTTY_SUCCESS) return 0;
  return length;
}
