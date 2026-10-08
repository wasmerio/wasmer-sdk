// SDL3 in a browser: programs linked with SDL built for WASIX, whose video
// driver is the one for <wasmer/gui.h> (packages/gui/integrations/sdl3), run
// in SDK workers. Their windows are canvases of the page, what SDL's
// software renderer draws is what the canvas shows, and what a user does
// (played here by Playwright) is what they read as SDL events.
//
// Build the programs with `make -C packages/gui sdl-programs imgui-demo`.
// Set WASMER_GUI_SCREENSHOTS to a directory to keep pictures of the page.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openPage, run, seen, until } from "./gui-browser.mjs";

const sdl = new URL("../../packages/gui/integrations/sdl3/", import.meta.url);
const events = new URL("tests/out/sdl_events.wasm", sdl);
const imgui = new URL("imgui/out/imgui_demo.wasm", sdl);
const skip = !existsSync(events) && "build packages/gui/integrations/sdl3/tests first (make sdl-programs)";
const skipImgui = !existsSync(imgui) && "build the Dear ImGui demo first (make imgui-demo)";

async function bytes(url) {
  return [...(await readFile(url))];
}

/** Keeps a picture of the page, where the run was given a place for them. */
async function picture(page, name) {
  const directory = process.env.WASMER_GUI_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
}

/** The colours of some pixels of a canvas, as the page shows it. */
function pixels(page, selector, points) {
  return page.evaluate(
    ({ selector, points }) => {
      const view = document.querySelector(selector);
      const copy = document.createElement("canvas");
      copy.width = view.width;
      copy.height = view.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      context.drawImage(view, 0, 0);
      return {
        size: [view.width, view.height],
        at: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
      };
    },
    { selector, points },
  );
}

function windowOpen(page, title) {
  return until(page, (title) => document.querySelector("#view").getAttribute("aria-label") === title, title);
}

test("SDL's events are what the user does on the canvas", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await bytes(events));
  await windowOpen(page, "SDL on Wasmer");
  await seen(page, "drew ");

  // The canvas is at (20, 20): this is (100, 50) in the window.
  await page.mouse.move(120, 70);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("a");
  await page.keyboard.down("Shift");
  await page.keyboard.press("B");
  await page.keyboard.up("Shift");
  await page.mouse.wheel(0, 100);
  await seen(page, "MOUSE_WHEEL ");

  // Text input: SDL gets text only while a program asked for it, typed
  // directly or put together by an input method.
  await page.keyboard.down("F4");
  await until(page, () => document.activeElement?.tagName === "TEXTAREA");
  await page.keyboard.up("F4");
  await page.keyboard.insertText("é");
  await page.keyboard.press("x");
  await seen(page, 'TEXT_INPUT "x"');
  await page.keyboard.down("F4");
  await until(page, () => document.querySelector("textarea") === null);
  await page.keyboard.up("F4");

  // SDL_SetClipboardText puts the text on the system's clipboard.
  await page.keyboard.down("F5");
  await until(page, async () => (await navigator.clipboard.readText()) === "copied by SDL");
  await page.keyboard.up("F5");

  // The program asked for 640 by 480, and a canvas can be given a size.
  // What the renderer drew is what the canvas shows: so far the one frame
  // of when the window opened, in the colour of a first frame.
  const first = await pixels(page, "#view", [[100, 50]]);
  assert.deepEqual(first.size, [640, 480]);
  assert.deepEqual(first.at[0], [40, 60, 90, 255]);

  // F7 asks for another size. The window gets it and is drawn again: in the
  // colour of a second frame, with a white square where the mouse is.
  await page.keyboard.down("F7");
  await seen(page, "drew 400x300");
  await page.keyboard.up("F7");
  await until(page, () => document.querySelector("#view").width === 400);
  const shown = await pixels(page, "#view", [
    [100, 50],
    [10, 10],
    [399, 299],
  ]);
  assert.deepEqual(shown.size, [400, 300]);
  assert.deepEqual(shown.at, [
    [255, 255, 255, 255],
    [56, 60, 90, 255],
    [56, 60, 90, 255],
  ]);
  await picture(page, "sdl-events");

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const lines = output.stdout.split("\n");
  assert.equal(lines[0], "video driver wasmer");
  assert.equal(lines[2], "window 640x480, 640x480 pixels, density=1 scale=1");
  assert.equal(lines[4], "renderer software, vsync on");
  // Frames come and go between the lines of input; what the user did is
  // there, in the order it was done.
  const input = lines.filter((line) => /^(KEY_|TEXT_|MOUSE_|WINDOW_FOCUS|WINDOW_MOUSE|CLIPBOARD|text input|copy)/.test(line));
  assert.deepEqual(input, [
    "WINDOW_MOUSE_ENTER",
    "MOUSE_MOTION at=100,50 rel=0,0 buttons=0x0",
    "WINDOW_FOCUS_GAINED",
    "MOUSE_BUTTON_DOWN button=1 clicks=1 at=100,50",
    "MOUSE_BUTTON_UP button=1 clicks=1 at=100,50",
    "KEY_DOWN A key=A mods=0",
    "KEY_UP A key=A mods=0",
    "KEY_DOWN Left Shift key=Left Shift mods=LShift",
    "KEY_DOWN B key=B mods=LShift",
    "KEY_UP B key=B mods=LShift",
    "KEY_UP Left Shift key=Left Shift mods=0",
    "MOUSE_WHEEL 0,-1 at=100,50",
    "KEY_DOWN F4 key=F4 mods=0",
    "text input on: ok",
    "KEY_UP F4 key=F4 mods=0",
    'TEXT_INPUT "é"',
    "KEY_DOWN X key=X mods=0",
    'TEXT_INPUT "x"',
    "KEY_UP X key=X mods=0",
    "KEY_DOWN F4 key=F4 mods=0",
    "text input off: ok",
    "KEY_UP F4 key=F4 mods=0",
    "KEY_DOWN F5 key=F5 mods=0",
    "copy: ok",
    "CLIPBOARD_UPDATE owner=1 types=1",
    "KEY_UP F5 key=F5 mods=0",
    "KEY_DOWN F7 key=F7 mods=0",
    "KEY_UP F7 key=F7 mods=0",
    "KEY_DOWN F9 key=F9 mods=0",
  ]);
  assert.match(output.stdout, /^quitting at 400x300 after 2 frames\ndone\n$/m);
  assert.deepEqual(errors, []);
});

test("an SDL program pastes what the user pasted", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await bytes(events));
  await windowOpen(page, "SDL on Wasmer");
  await page.evaluate(() => navigator.clipboard.writeText("copied elsewhere"));
  await page.mouse.click(120, 70);
  // The platform's paste shortcut. SDL_GetClipboardText has to answer at
  // once, and a browser has to be asked first: the driver asks and waits.
  await page.keyboard.press("ControlOrMeta+V");
  await seen(page, "pasted ");
  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /^pasted text "copied elsewhere"$/m, output.stdout);
  assert.deepEqual(errors, []);
});

test("SDL's fullscreen and relative mouse mode follow something the user did", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await bytes(events));
  await windowOpen(page, "SDL on Wasmer");
  await page.mouse.move(120, 70);
  await page.mouse.click(120, 70);

  // SDL_SetWindowFullscreen: the key press is the user's gesture the
  // browser wants to see first. SDL hears that it happened, and the size.
  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === document.querySelector("#view"));
  await seen(page, "drew 800x600");
  await page.keyboard.up("F1");
  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === null);
  // SDL has heard all of it when the window has its old size again.
  await seen(page, "WINDOW_RESIZED 640x480");
  await page.keyboard.up("F1");

  // SDL_SetWindowRelativeMouseMode locks the cursor: the mouse then says
  // how far it moved, and SDL counts a position of its own from that.
  await page.keyboard.down("F2");
  await until(page, () => document.pointerLockElement === document.querySelector("#view"));
  await page.keyboard.up("F2");
  await page.mouse.move(130, 75);
  await seen(page, "MOUSE_MOTION at=110,55 rel=10,5");
  await page.keyboard.down("F3");
  await until(page, () => document.pointerLockElement === null);
  await page.keyboard.up("F3");

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const lines = output.stdout.split("\n");
  const from = (text) => {
    const at = lines.findIndex((line) => line.startsWith(text));
    assert.notEqual(at, -1, `no line starts with ${JSON.stringify(text)} in\n${output.stdout}`);
    return lines.splice(0, at + 1).at(-1);
  };
  // In this order: into fullscreen, at the size of the screen, and out
  // again, at the size the window had.
  from("fullscreen on: asked");
  from("WINDOW_ENTER_FULLSCREEN");
  from("WINDOW_RESIZED 800x600");
  from("drew 800x600");
  from("fullscreen off: asked");
  from("WINDOW_LEAVE_FULLSCREEN");
  from("WINDOW_RESIZED 640x480");
  from("relative on: ok");
  from("MOUSE_MOTION at=110,55 rel=10,5");
  from("relative off: ok");
  assert.deepEqual(errors, []);
});

test("an SDL program that waits for events lets its thread sleep", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // Nothing happens for three seconds; then a timer on another thread of
  // the program ends SDL_WaitEvent. A program that polled meanwhile would
  // have drawn or printed: this one drew its window once.
  const output = await run(page, await bytes(events), ["--quit-after", "3000"]);
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /^QUIT\nquitting at 640x480 after 1 frames\ndone\n$/m, output.stdout);
  assert.deepEqual(errors, []);
});

test("an SDL program that draws every frame runs at the display's pace", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // A loop that polls for events and presents with vsync, as games do, for
  // two seconds. What paces it is the page's animation frames: 60 a second
  // here. Left to itself it would draw many hundreds.
  const output = await run(page, await bytes(events), ["--animate", "2000"]);
  assert.equal(output.exitCode, 0, output.stderr);
  const drawn = output.stdout.match(/^animated (\d+) frames in (\d+) ms$/m);
  assert.ok(drawn, output.stdout);
  const perSecond = (Number(drawn[1]) * 1000) / Number(drawn[2]);
  assert.ok(perSecond > 40 && perSecond < 70, `${drawn[0]}: ${perSecond.toFixed(1)} a second`);
  assert.deepEqual(errors, []);
});

test("Ctrl-C's signal is SDL's quit event, in a loop that waits and in one that draws", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // The program sends itself SIGINT from SDL's timer thread, as a terminal
  // does on Ctrl-C. SDL has a handler for it, which runs where the program
  // asks the host for events, and the program leaves the way it does for
  // any quit event.
  const waiting = await run(page, await bytes(events), ["--interrupt-after", "500"]);
  assert.equal(waiting.exitCode, 0, waiting.stderr);
  assert.match(waiting.stdout, /^interrupting\nQUIT\nquitting at 640x480 after 1 frames\ndone\n$/m, waiting.stdout);

  // Drawing frame after frame for a minute, were it not interrupted.
  const started = Date.now();
  const drawing = await run(page, await bytes(events), ["--interrupt-after", "500", "--animate", "60000"]);
  assert.equal(drawing.exitCode, 0, drawing.stderr);
  assert.match(drawing.stdout, /^interrupting\nanimated \d+ frames in \d+ ms\n/m, drawing.stdout);
  assert.ok(Date.now() - started < 20_000, `${Date.now() - started} ms`);
  assert.deepEqual(errors, []);
});

const IMGUI_PAGE = `<!doctype html>
<title>Dear ImGui on SDL</title>
<style>
  body { margin: 0; background: #222; }
  #view { display: block; width: 1000px; height: 700px; }
</style>
<canvas id="view"></canvas>`;

test("the Dear ImGui demo draws and answers the mouse", { timeout: 300_000, skip: skipImgui }, async (context) => {
  const { page, errors, unavailable } = await openPage(context, { viewport: { width: 1000, height: 700 } }, IMGUI_PAGE);
  if (unavailable) return context.skip(unavailable);

  // The example is Dear ImGui's own, unchanged: it draws frame after frame
  // until its window is closed, which nothing in a page does. It is killed.
  const frames = await page.evaluate(async (bytes) => {
    const { Wasmer } = await import("/dist/index.js");
    const client = new Wasmer({ cache: false });
    const pkg = await client.packages.load(new Uint8Array(bytes));
    const sandbox = await client.sandboxes.create({
      packages: [pkg],
      // The page lays the canvas out: the program gets a window of that
      // size, whatever it asked for, as on a phone.
      gui: { canvas: document.querySelector("#view"), resizable: false },
    });
    const process = await sandbox.command(pkg).spawn();
    globalThis.__stop = async () => {
      await process.kill();
      await process.wait({ check: false });
      await sandbox.close();
      await client.close();
    };
    // Frames, as the page sees them arrive.
    const view = document.querySelector("#view");
    const context2d = () => {
      const copy = document.createElement("canvas");
      copy.width = view.width;
      copy.height = view.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      context.drawImage(view, 0, 0);
      return context;
    };
    globalThis.__at = (x, y) => [...context2d().getImageData(x, y, 1, 1).data];
    return true;
  }, await bytes(imgui));
  assert.equal(frames, true);

  // The demo's two windows are where Dear ImGui puts them: "Hello, world!"
  // at (60, 60) and the demo window at (650, 20), dark on the clear colour.
  // A canvas nothing was drawn on is transparent black: the first frame is
  // there when the clear colour is. The program is big, and the browser
  // compiles it first.
  const dark = ([r, g, b, a]) => r < 40 && g < 40 && b < 40 && a === 255;
  await page.waitForFunction(
    () => {
      const [r, g, b, a] = globalThis.__at(500, 500);
      return Math.abs(r - 115) < 4 && Math.abs(g - 140) < 4 && Math.abs(b - 153) < 4 && a === 255;
    },
    undefined,
    { timeout: 120_000, polling: 50 },
  );
  await picture(page, "imgui-1-start");
  const inside = await page.evaluate(() => globalThis.__at(800, 400));
  assert.ok(dark(inside), `the demo window is dark, not ${inside}`);
  assert.deepEqual(await page.evaluate(() => [document.querySelector("#view").width, document.querySelector("#view").height]), [1000, 700]);

  // A click on the arrow in its title bar folds the demo window away: what
  // was under it shows.
  await page.mouse.move(661, 29);
  await page.mouse.down();
  await page.mouse.up();
  await until(page, () => {
    const [r, g, b] = globalThis.__at(800, 400);
    return Math.abs(r - 115) < 4 && Math.abs(g - 140) < 4 && Math.abs(b - 153) < 4;
  });
  await picture(page, "imgui-2-folded");

  // And a second one unfolds it.
  await page.mouse.down();
  await page.mouse.up();
  await until(page, () => {
    const [r, g, b, a] = globalThis.__at(800, 400);
    return r < 40 && g < 40 && b < 40 && a === 255;
  });

  // The slider is dragged: its grab follows the mouse.
  await page.mouse.move(100, 159);
  await page.mouse.down();
  await page.mouse.move(250, 159, { steps: 5 });
  await page.mouse.up();
  await picture(page, "imgui-3-dragged");

  // How fast it draws, by the page's own count of animation frames in
  // which the canvas changed is not to be had; what the program shows is
  // read by eye from the pictures. That it keeps drawing is checked here:
  // hovering a header lights it up.
  await page.mouse.move(707, 165);
  await until(page, () => {
    const [r, g, b] = globalThis.__at(900, 165);
    return b > 150 && r < 110;
  });
  await picture(page, "imgui-4-hover");

  await page.evaluate(() => globalThis.__stop());
  assert.deepEqual(errors, []);
});
