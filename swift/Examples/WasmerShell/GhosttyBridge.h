#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct WTTerminal WTTerminal;
typedef struct {
  uint16_t column, row;
  const uint8_t *text;
  size_t length;
  uint32_t foreground, background;
  uint8_t width;
  bool bold, italic, underline, strike;
} WTCell;
typedef struct {
  uint16_t column, row;
  bool visible;
  uint32_t background, foreground;
} WTFrame;

WTTerminal *wt_new(uint16_t columns, uint16_t rows);
void wt_free(WTTerminal *terminal);
void wt_feed(WTTerminal *terminal, const uint8_t *bytes, size_t length);
bool wt_resize(WTTerminal *terminal, uint16_t columns, uint16_t rows);
void wt_scroll(WTTerminal *terminal, int delta);
void wt_bottom(WTTerminal *terminal);
bool wt_begin_frame(WTTerminal *terminal, WTFrame *frame);
bool wt_next_cell(WTTerminal *terminal, WTCell *cell);
size_t wt_take_response(WTTerminal *terminal, uint8_t *bytes, size_t capacity);
// 0 up, 1 down, 2 left, 3 right, 4 backspace, 5 enter, 6 tab, 7 escape.
size_t wt_key(WTTerminal *terminal, int key, uint8_t *bytes, size_t capacity);
