// winit in a browser, the WASIX way: Rust programs built for
// wasm32-wasmer-wasi against winit and softbuffer with their backends for
// <wasmer/gui.h> (packages/gui/integrations/winit) run in SDK workers. Their
// windows are canvases of the page, what softbuffer presents is what the
// canvas shows, and what a user does (played here by Playwright) is what
// they get as winit events. No wasm-bindgen is involved: these are the same
// files that run under `wasmer run`.
//
// Build the programs with `make -C packages/gui winit-programs`.
// Set WASMER_GUI_SCREENSHOTS to a directory to keep pictures of the page.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openPage, run, seen, until } from "./gui-browser.mjs";

const winit = new URL("../../packages/gui/integrations/winit/", import.meta.url);
const events = new URL("tests/out/winit_events.wasm", winit);
const example = new URL("example/out/window.wasm", winit);
const skip = !existsSync(events) && "build packages/gui/integrations/winit first (make winit-programs)";

async function bytes(url) {
  return [...(await readFile(url))];
}

async function picture(page, name) {
  const directory = process.env.WASMER_GUI_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
}

/** The colour of a pixel of the canvas, as the page shows it. */
function pixel(page, x, y) {
  return page.evaluate(
    ([x, y]) => {
      const view = document.querySelector("#view");
      const copy = document.createElement("canvas");
      copy.width = view.width;
      copy.height = view.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      context.drawImage(view, 0, 0);
      return [view.width, view.height, ...context.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
}

function windowOpen(page, title) {
  return until(page, (title) => document.querySelector("#view").getAttribute("aria-label") === title, title);
}

test("winit's events are what the user does on the canvas", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await bytes(events));
  await windowOpen(page, "winit on Wasmer");
  await seen(page, "RedrawRequested: drew 640x480");
  // What softbuffer presented is what the canvas shows: the colour of the
  // program's first frame, at the size it asked its window to be.
  assert.deepEqual(await pixel(page, 100, 50), [640, 480, 40, 60, 90, 255]);

  // The canvas is at (20, 20): this is (100, 50) in the window.
  await page.mouse.move(120, 70);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("a");
  await page.keyboard.down("Shift");
  await page.keyboard.press("B");
  await page.keyboard.up("Shift");
  await page.mouse.wheel(0, 100);
  await seen(page, "MouseWheel ");

  // Input methods: winit gets what one composes and commits as Ime events,
  // and what a key types on the key's own event.
  await page.keyboard.down("F4");
  await until(page, () => document.activeElement?.tagName === "TEXTAREA");
  await page.keyboard.up("F4");
  await page.keyboard.insertText("é");
  await page.keyboard.press("x");
  await seen(page, 'KeyboardInput Released KeyX');
  await page.keyboard.down("F4");
  await until(page, () => document.querySelector("textarea") === null);
  await page.keyboard.up("F4");

  // F7 asks for another size. The window gets it and is drawn again, in the
  // colour of a second frame.
  await page.keyboard.down("F7");
  await seen(page, "RedrawRequested: drew 400x300");
  await page.keyboard.up("F7");
  await until(page, () => document.querySelector("#view").width === 400);
  assert.deepEqual(await pixel(page, 399, 299), [400, 300, 56, 60, 90, 255]);
  await picture(page, "winit-events");

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const lines = output.stdout.split("\n");
  assert.equal(lines[0], "resumed");
  assert.match(lines[1], /^monitor ".*" 800x600 scale 1 at \d+ mHz, primary$/);
  assert.match(lines[2], /^window 640x480 scale 1 theme Some\((Light|Dark)\), surface selector wgui: and 32 more$/);
  const input = lines.filter((line) => /^(Keyboard|Modifiers|Cursor|Mouse|Focused|Ime|input methods|size)/.test(line));
  assert.deepEqual(input, [
    "CursorEntered",
    "CursorMoved 100,50",
    "Focused true",
    "MouseInput Pressed Left",
    "MouseInput Released Left",
    'KeyboardInput Pressed KeyA key="a" unmodified="a" text=Some("a") all=Some("a") Standard',
    'KeyboardInput Released KeyA key="a" unmodified="a" text=None all=None Standard',
    "KeyboardInput Pressed ShiftLeft key=Shift unmodified=Shift text=None all=None Left",
    "ModifiersChanged ModifiersState(SHIFT) left shift Unknown",
    'KeyboardInput Pressed KeyB key="B" unmodified="B" text=Some("B") all=Some("B") Standard',
    'KeyboardInput Released KeyB key="B" unmodified="B" text=None all=None Standard',
    "KeyboardInput Released ShiftLeft key=Shift unmodified=Shift text=None all=None Left",
    "ModifiersChanged ModifiersState(0x0) left shift Unknown",
    "MouseWheel pixels 0,-100 Moved",
    "KeyboardInput Pressed F4 key=F4 unmodified=F4 text=None all=None Standard",
    "input methods on",
    "Ime Enabled",
    "KeyboardInput Released F4 key=F4 unmodified=F4 text=None all=None Standard",
    'Ime Commit "é"',
    'KeyboardInput Pressed KeyX key="x" unmodified="x" text=Some("x") all=Some("x") Standard',
    'KeyboardInput Released KeyX key="x" unmodified="x" text=None all=None Standard',
    "KeyboardInput Pressed F4 key=F4 unmodified=F4 text=None all=None Standard",
    "input methods off",
    "Ime Disabled",
    "KeyboardInput Released F4 key=F4 unmodified=F4 text=None all=None Standard",
    "KeyboardInput Pressed F7 key=F7 unmodified=F7 text=None all=None Standard",
    "size 400x300: None",
    "KeyboardInput Released F7 key=F7 unmodified=F7 text=None all=None Standard",
    "KeyboardInput Pressed F9 key=F9 unmodified=F9 text=None all=None Standard",
  ]);
  assert.match(output.stdout, /^exiting at 400x300 after 2 frames\ndone\n$/m);
  assert.deepEqual(errors, []);
});

test("winit's fullscreen and cursor lock follow something the user did", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await bytes(events));
  await windowOpen(page, "winit on Wasmer");
  await page.mouse.move(120, 70);
  await page.mouse.click(120, 70);

  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === document.querySelector("#view"));
  await seen(page, "RedrawRequested: drew 800x600");
  await page.keyboard.up("F1");
  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === null);
  // The program has heard of it when it has its window's old size again,
  // which it was also told when the window opened.
  await until(page, () => globalThis.__lines.filter((line) => line === "Resized 640x480").length === 2);
  await page.keyboard.up("F1");

  // A locked cursor does not move: how far the mouse did is a device event.
  await page.keyboard.down("F2");
  await until(page, () => document.pointerLockElement === document.querySelector("#view"));
  await page.keyboard.up("F2");
  await page.mouse.move(130, 75);
  await seen(page, "device MouseMotion 10,5");
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
  from("fullscreen on");
  from("Resized 800x600");
  from("RedrawRequested: drew 800x600");
  from("fullscreen off");
  from("Resized 640x480");
  from("lock: Ok(())");
  from("device MouseMotion 10,5");
  from("release: Ok(())");
  assert.deepEqual(errors, []);
});

test("a winit program that waits lets its thread sleep, and one that draws keeps the display's pace", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // Nothing happens for three seconds; then another thread of the program
  // sends the loop an event, which has to end its wait in the host.
  const waited = await run(page, await bytes(events), ["--quit-after", "3000"]);
  assert.equal(waited.exitCode, 0, waited.stderr);
  assert.match(waited.stdout, /^user event Quit\nexiting at 640x480 after 1 frames\ndone\n$/m, waited.stdout);

  // A loop that is polled and asks for a redraw every turn: the page's
  // animation frames are what it gets them by, 60 a second here.
  const animated = await run(page, await bytes(events), ["--animate", "2000"]);
  assert.equal(animated.exitCode, 0, animated.stderr);
  const drawn = animated.stdout.match(/^animated (\d+) frames in (\d+) ms$/m);
  assert.ok(drawn, animated.stdout);
  const perSecond = (Number(drawn[1]) * 1000) / Number(drawn[2]);
  assert.ok(perSecond > 40 && perSecond < 70, `${drawn[0]}: ${perSecond.toFixed(1)} a second`);
  assert.deepEqual(errors, []);
});

test("Ctrl-C's signal ends a winit program, in a loop that waits and in one that draws", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // The program sends itself SIGINT from another thread, as a terminal does
  // on Ctrl-C. winit has nothing to say about signals, and a program that
  // has not either is ended, with the status of one a signal ended.
  for (const more of [[], ["--animate", "60000"]]) {
    const started = Date.now();
    const output = await run(page, await bytes(events), ["--interrupt-after", "500", ...more]);
    assert.equal(output.exitCode, 130, `${more}: ${output.stdout}${output.stderr}`);
    assert.match(output.stdout, /^interrupting\n$/m, output.stdout);
    assert.ok(Date.now() - started < 20_000, `${more}: ${Date.now() - started} ms`);
  }
  assert.deepEqual(errors, []);
});

test("winit's own window example runs", { timeout: 300_000, skip: !existsSync(example) && skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // examples/window.rs of winit 0.30, unchanged. It runs until its windows
  // are closed, which nothing in a page does: it is killed.
  await page.evaluate(async (bytes) => {
    const { Wasmer } = await import("/dist/index.js");
    const client = new Wasmer({ cache: false });
    const pkg = await client.packages.load(new Uint8Array(bytes));
    const sandbox = await client.sandboxes.create({
      packages: [pkg],
      gui: { canvas: document.querySelector("#view") },
    });
    const process = await sandbox.command(pkg).spawn({ stdout: "pipe" });
    const lines = (globalThis.__lines = []);
    (async () => {
      for await (const line of process.stdout.lines()) lines.push(line.replace(/\u001b\[[0-9;]*m/g, ""));
    })();
    globalThis.__stop = async () => {
      await process.kill();
      await process.wait({ check: false });
      await sandbox.close();
      await client.close();
    };
  }, await bytes(example));
  const logged = (text) =>
    page.waitForFunction((text) => (globalThis.__lines ?? []).some((line) => line.includes(text)), text, {
      timeout: 60_000,
      polling: 20,
    });

  await windowOpen(page, "Winit window");
  await logged("Created new window");
  // It fills its window with the colour of its theme: white, or a dark grey.
  const light = (colour) => colour.slice(2).join() === "255,255,255,255";
  const dark = (colour) => colour.slice(2).join() === "24,24,24,255";
  await until(page, () => {
    const view = document.querySelector("#view");
    const copy = document.createElement("canvas");
    copy.width = view.width;
    copy.height = view.height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    context.drawImage(view, 0, 0);
    return context.getImageData(10, 10, 1, 1).data[3] === 255;
  });
  const first = await pixel(page, 10, 10);
  assert.ok(light(first) || dark(first), `the window is filled with ${first}`);

  // Its key bindings: Control and K is the dark theme, Control and Z hides
  // the cursor.
  await page.mouse.click(120, 70);
  await logged("focused");
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await logged("Executing action: SetTheme(Some(Dark))");
  await page.keyboard.press("z");
  await logged("Executing action: ToggleCursorVisibility");
  await page.keyboard.up("Control");
  await until(page, () => document.querySelector("#view").style.cursor === "none");
  await page.waitForFunction(() => {
    const view = document.querySelector("#view");
    const copy = document.createElement("canvas");
    copy.width = view.width;
    copy.height = view.height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    context.drawImage(view, 0, 0);
    return context.getImageData(10, 10, 1, 1).data[0] === 24;
  });
  assert.ok(dark(await pixel(page, 10, 10)));
  await picture(page, "winit-window-example");

  await page.evaluate(() => globalThis.__stop());
  assert.deepEqual(errors, []);
});
