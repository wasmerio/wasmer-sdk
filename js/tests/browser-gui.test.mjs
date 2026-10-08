// Windows for guests, end to end in a browser: C programs built against
// <wasmer/gui.h> (packages/gui/tests/programs) run in SDK workers, their
// windows are canvases of the page, and what a user does on a canvas
// (played here by Playwright, with real key, mouse and wheel input) is
// what they read as events.
//
// Build the programs with `make -C packages/gui programs`. By default the
// installed Chrome is used, in its new headless mode; set
// WASMER_GUI_BROWSER_CHANNEL (a Playwright channel, or "bundled" for
// Playwright's own Chromium) to use another one.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openPage, run, seen, until } from "./gui-browser.mjs";

const gui = new URL("../../packages/gui/", import.meta.url);
const programs = new URL("tests/programs/out/", gui);
const built = existsSync(new URL("events.wasm", programs));
const skip = !built && "build packages/gui/tests/programs first";
const drawn = existsSync(new URL("examples/out/triangle.wasm", gui));

async function program(name) {
  return [...(await readFile(new URL(`${name}.wasm`, programs)))];
}

test("a guest's window is a canvas of the page", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const output = await run(page, await program("window_smoke"));
  assert.equal(output.exitCode, 0, output.stderr);
  // What the program prints on every host, but for what a canvas is not: a
  // window with a frame that the user can drag to another size.
  assert.equal(
    output.stdout,
    "the first display is the primary one: yes\n" +
      "opened at 320x200 logical units\n" +
      "visible: yes, resizable: no, decorated: no\n" +
      "on a display: yes\n" +
      "selector: 37 bytes, starts with wgui:\n" +
      "resized to 400x250 logical units\n" +
      "asked to draw\n" +
      "done\n",
  );
  // The canvas is the page's again, as it was.
  const after = await page.evaluate(() => {
    const view = document.querySelector("#view");
    return [view.hasAttribute("tabindex"), view.hasAttribute("aria-label"), view.style.width];
  });
  assert.deepEqual(after, [false, false, ""]);
  assert.deepEqual(errors, []);
});

/** The canvas is a window once it carries the window's title. */
function windowOpen(page, title = "events") {
  return until(page, (title) => document.querySelector("#view").getAttribute("aria-label") === title, title);
}

test("what the user does on the canvas is what the guest reads", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);

  // The canvas is at (20, 20): this is (100, 50) in the window.
  await page.mouse.move(120, 70);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("a");
  await page.keyboard.down("Shift");
  await page.keyboard.press("B");
  await page.keyboard.up("Shift");
  await page.mouse.wheel(0, 120);

  // Text entry: the canvas gets a text field to stand in for it, and what
  // is inserted there (by an input method, here) is committed to the
  // guest. Each key is let go only once the guest has answered it, so that
  // what it prints is in one order.
  await page.keyboard.down("F4");
  await until(page, () => document.activeElement?.tagName === "TEXTAREA");
  await page.keyboard.up("F4");
  await page.keyboard.insertText("é");
  await page.keyboard.press("x");
  await page.keyboard.down("F4");
  await until(page, () => document.querySelector("textarea") === null);
  await page.keyboard.up("F4");

  // Copying puts the guest's text on the system's clipboard.
  await page.keyboard.down("F5");
  await until(page, async () => (await navigator.clipboard.readText()) === "copied by the guest");
  await page.keyboard.up("F5");

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(
    output.stdout,
    `host Browser, version 0.1
WindowResized w1 300x200 scale=1 changed=Size|ScaleFactor [Synthetic]
PointerEnter w1 id=1 Mouse flags=Primary buttons=0 at=100,50 delta=0,0 pressure=0
PointerMotion w1 id=1 Mouse flags=Primary buttons=0 at=100,50 delta=0,0 pressure=0
WindowFocusGained w1
PointerDown w1 id=1 Mouse flags=Primary|InContact button=1 buttons=Primary at=100,50 delta=0,0 pressure=0.5
PointerUp w1 id=1 Mouse flags=Primary button=1 buttons=0 at=100,50 delta=0,0 pressure=0
KeyDown w1 KeyA key='a' text="a"
KeyUp w1 KeyA key='a'
KeyDown w1 ShiftLeft key=Shift mods=Shift location=Left
ModifiersChanged w1 mods=Shift
KeyDown w1 KeyB key='B' mods=Shift text="B"
KeyUp w1 KeyB key='B' mods=Shift
KeyUp w1 ShiftLeft key=Shift location=Left
ModifiersChanged w1 mods=0
Wheel w1 Pixel phase=None delta=0,120 at=100,50
KeyDown w1 F4 key=F4
TextInputState w1 state=Active
KeyUp w1 F4 key=F4
TextCommit w1 "é"
KeyDown w1 KeyX key='x' text="x"
TextCommit w1 "x" flags=FromKey
KeyUp w1 KeyX key='x'
KeyDown w1 F4 key=F4
TextInputState w1 state=0
KeyUp w1 F4 key=F4
KeyDown w1 F5 key=F5
RequestCompleted tag=1 kind=ClipboardWrite status=Success
ClipboardChanged Clipboard flags=Owned|HasText
KeyUp w1 F5 key=F5
KeyDown w1 F9 key=F9
closing at 300x200, flags=Visible|Focused|Hovered
done
`,
  );
  assert.deepEqual(errors, []);
});

test("a paste by the user is what lets the guest read the clipboard", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);
  await page.evaluate(() => navigator.clipboard.writeText("copied elsewhere"));
  await page.mouse.click(120, 70);
  // The platform's paste shortcut: the browser fires its paste event, and
  // the guest, which hears the keys, reads what was pasted.
  await page.keyboard.press("ControlOrMeta+V");
  // Read at once, or after asking: either way the guest gets what was pasted.
  await seen(page, "pasted ");
  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /^pasted "copied elsewhere"$/m, output.stdout);
  assert.deepEqual(errors, []);
});

test("a guest that never pasted cannot read the clipboard", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"), [], { permissions: { clipboardRead: "deny" } });
  await windowOpen(page);
  await page.evaluate(() => navigator.clipboard.writeText("not for the guest"));
  await page.mouse.click(120, 70);
  await page.keyboard.press("ControlOrMeta+V");
  await seen(page, "paste: ");
  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /^paste: Denied$/m, output.stdout);
  assert.doesNotMatch(output.stdout, /not for the guest/);
  assert.deepEqual(errors, []);
});

test("fullscreen and the cursor lock follow something the user did", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);
  await page.mouse.move(120, 70);
  await page.mouse.click(120, 70);

  // F1 asks for fullscreen. The key press is the user's gesture the browser
  // wants to see first.
  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === document.querySelector("#view"));
  await page.keyboard.up("F1");
  await page.keyboard.down("F1");
  await until(page, () => document.fullscreenElement === null);
  await page.keyboard.up("F1");

  // F2 locks the cursor: the mouse then only says how far it moved.
  await page.keyboard.down("F2");
  await until(page, () => document.pointerLockElement === document.querySelector("#view"));
  await page.keyboard.up("F2");
  await page.mouse.move(130, 75);
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
  // In this order: into fullscreen, with a new size, and out again.
  from("WindowFlagsChanged w1 flags=Visible|Focused|Hovered|Fullscreen changed=Fullscreen");
  from("RequestCompleted w1 tag=1 kind=Fullscreen status=Success");
  from("WindowResized w1 800x600 scale=1 changed=Size");
  from("WindowFlagsChanged w1 flags=Visible|Focused|Hovered changed=Fullscreen");
  from("RequestCompleted w1 tag=2 kind=Fullscreen status=Success");
  from("WindowResized w1 300x200 scale=1 changed=Size");
  // The lock, movement without a position, and the release the guest asked for.
  from("RequestCompleted w1 tag=3 kind=CursorGrab status=Success");
  from("WindowCursorGrabChanged w1 grab=Locked reason=Requested");
  const moved = from("PointerMotion w1");
  assert.match(moved, /at=100,50 delta=10,5 /, moved);
  from("RequestCompleted w1 tag=4 kind=CursorGrab status=Success");
  from("WindowCursorGrabChanged w1 grab=None reason=Requested");
  assert.deepEqual(errors, []);
});

test("the page's layout is what sizes a window", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);
  await page.evaluate(() => {
    const view = document.querySelector("#view");
    view.style.width = "450px";
    view.style.height = "250px";
  });
  // The drawing surface follows: the canvas has as many pixels as it shows.
  await until(page, () => document.querySelector("#view").width === 450);
  await page.mouse.click(120, 70);
  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /^WindowResized w1 450x250 scale=1 changed=Size$/m, output.stdout);
  assert.match(output.stdout, /^closing at 450x250, /m, output.stdout);
  assert.deepEqual(errors, []);
});

test("a guest that waits for input can be killed, and its window goes", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const result = await page.evaluate(async (bytes) => {
    const { Wasmer } = await import("/dist/index.js");
    const view = document.querySelector("#view");
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      const pkg = await client.packages.load(new Uint8Array(bytes));
      sandbox = await client.sandboxes.create({ packages: [pkg], gui: { canvas: view } });
      const process = await sandbox.command(pkg).spawn();
      while (view.getAttribute("aria-label") !== "events") {
        await new Promise((done) => setTimeout(done, 10));
      }
      const killed = performance.now();
      await process.kill();
      const output = await process.wait({ check: false });
      const took = performance.now() - killed;
      // The canvas is free again for the next command of the sandbox.
      const freed = !view.hasAttribute("aria-label");
      const again = await sandbox.command(pkg).spawn();
      while (view.getAttribute("aria-label") !== "events") {
        await new Promise((done) => setTimeout(done, 10));
      }
      await again.kill();
      await again.wait({ check: false });
      return { ok: output.ok, took, freed, enabled: sandbox.gui.enabled };
    } finally {
      await sandbox?.close();
      await client.close();
    }
  }, await program("events"));

  assert.equal(result.ok, false);
  assert.ok(result.took < 2000, `it took ${result.took} ms to die`);
  assert.equal(result.freed, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(errors, []);
});

test("a sandbox without a GUI has no windows to give", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const result = await page.evaluate(async () => {
    const { Wasmer } = await import("/dist/index.js");
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      sandbox = await client.sandboxes.create({});
      let refused;
      try {
        sandbox.gui.setCanvas(document.querySelector("#view"));
      } catch (error) {
        refused = error.code;
      }
      // A window has to be a canvas.
      let invalid;
      try {
        await client.sandboxes.create({ gui: { canvas: document.body } });
      } catch (error) {
        invalid = error.code;
      }
      let unknown;
      try {
        await client.sandboxes.create({ gui: { permissions: { clipboardRead: "sometimes" } } });
      } catch (error) {
        unknown = error.code;
      }
      return { enabled: sandbox.gui.enabled, refused, invalid, unknown };
    } finally {
      await sandbox?.close();
      await client.close();
    }
  });

  assert.deepEqual(result, {
    enabled: false,
    refused: "CAPABILITY_UNAVAILABLE",
    invalid: "INVALID_ARGUMENT",
    unknown: "INVALID_ARGUMENT",
  });
  assert.deepEqual(errors, []);
});

test("a guest draws with WebGPU on the window it has input in", { timeout: 180_000, skip: !drawn && "build packages/gui/examples first" }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);
  const ready = await page.evaluate(async () => {
    const jspi = typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
    return jspi && Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  });
  if (!ready) return context.skip("this browser has no WebGPU adapter, or cannot suspend a guest");

  const triangle = [...(await readFile(new URL("examples/out/triangle.wasm", gui)))];
  const result = await page.evaluate(async (bytes) => {
    const { Wasmer } = await import("/dist/index.js");
    const view = document.querySelector("#view");
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      const pkg = await client.packages.load(new Uint8Array(bytes));
      // One canvas, for both: the window the guest opens is the canvas it
      // draws on, found by the name the window gives out.
      sandbox = await client.sandboxes.create({
        packages: [pkg],
        gui: { canvas: view },
        webgpu: true,
      });
      const output = await sandbox.command(pkg, ["8"]).run({ check: false });
      // Frames travel through this thread's message queue: let them land.
      await new Promise((done) => setTimeout(done, 200));
      const copy = document.createElement("canvas");
      copy.width = view.width;
      copy.height = view.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      context.drawImage(view, 0, 0);
      const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
      return {
        exitCode: output.exitCode,
        stdout: output.stdout.text(),
        stderr: output.stderr.text(),
        size: [view.width, view.height],
        corner: at(2, 2),
        center: at(view.width >> 1, view.height >> 1),
      };
    } finally {
      await sandbox?.close();
      await client.close();
    }
  }, triangle);

  assert.equal(result.exitCode, 0, result.stderr);
  // The example asks for 640 by 480, and this page's layout lets the canvas
  // be that.
  assert.equal(result.stdout, "presented 8 frames at 640x480\n");
  assert.deepEqual(result.size, [640, 480]);
  // The background the example clears to, and its triangle in the middle.
  const [red, green, blue, alpha] = result.corner;
  assert.ok(red < 40 && green < 40 && blue < 60 && alpha === 255, `corner ${result.corner}`);
  assert.ok(Math.max(...result.center.slice(0, 3)) > 100, `center ${result.center}`);
  assert.deepEqual(errors, []);
});

test("programs that need no user print what they print on every host", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const names = ["link_all", "threads", "newer", "misuse"];
  const modules = {};
  for (const name of names) modules[name] = await program(name);
  const outputs = await page.evaluate(async (modules) => {
    const { Wasmer } = await import("/dist/index.js");
    const client = new Wasmer({ cache: false });
    const outputs = {};
    let sandbox;
    try {
      // A canvas for every window that is asked for: these programs open
      // more than one.
      const made = [];
      sandbox = await client.sandboxes.create({
        gui: {
          canvas: () => {
            const canvas = document.createElement("canvas");
            canvas.style.cssText = "display: block; width: 300px; height: 200px";
            document.body.append(canvas);
            made.push(canvas);
            return canvas;
          },
        },
      });
      for (const [name, bytes] of Object.entries(modules)) {
        const pkg = await client.packages.load(new Uint8Array(bytes));
        await sandbox.installPackage(pkg);
        const output = await sandbox.command(pkg).run({ check: false });
        outputs[name] = {
          exitCode: output.exitCode,
          stdout: output.stdout.text(),
          stderr: output.stderr.text(),
        };
      }
      // Every one of them is the page's again.
      outputs.left = made.filter((canvas) => canvas.hasAttribute("tabindex")).length;
      outputs.made = made.length;
    } finally {
      await sandbox?.close();
      await client.close();
    }
    return outputs;
  }, modules);

  for (const name of names) {
    let expected = await readFile(new URL(`tests/expected/${name}.txt`, gui), "utf8");
    // What a canvas is not: something a guest can minimise.
    if (name === "misuse") {
      expected = expected.replace("refused flags: Focused\n", "refused flags: Minimized|Focused\n");
    }
    const output = outputs[name];
    assert.equal(output.stdout, expected, `${name}: ${output.stderr}`);
    assert.equal(output.exitCode, 0, `${name}: ${output.stderr}`);
  }
  assert.ok(outputs.made >= 3, `${outputs.made} canvases were asked for`);
  assert.equal(outputs.left, 0);
  assert.deepEqual(errors, []);
});

test("a signal reaches a program that only asks or waits for events", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // WASIX delivers a signal where a program enters the system, and these
  // loops never do: the host lets it in where they ask and wait for events.
  // Each run sends itself one from a second thread, and its handler has to
  // run for the loop to end.
  const bytes = await program("signals");
  for (const [mode, name] of [["poll", "polling"], ["wait", "waiting"], ["sleep", "sleeping"]]) {
    const output = await run(page, bytes, [mode]);
    const expected = await readFile(new URL(`tests/expected/signals_${name}.txt`, gui), "utf8");
    assert.equal(output.stdout, expected, `${mode}: ${output.stderr}`);
    assert.equal(output.exitCode, 0, `${mode}: ${output.stderr}`);
  }
  assert.deepEqual(errors, []);
});

test("a guest without a GPU draws its window itself", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const output = await run(page, await program("pixels"));
  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stdout, await readFile(new URL("tests/expected/pixels.txt", gui), "utf8"));

  // What the program presented last is what the canvas shows: its pattern,
  // at the size it asked the window to be.
  const shown = await page.evaluate(() => {
    const view = document.querySelector("#view");
    const { width, height } = view;
    // Read from a copy made for reading, as the page shows the canvas.
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    context.drawImage(view, 0, 0);
    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return {
      size: [width, height],
      corner: at(0, 0),
      insideCorner: at(15, 15),
      besideCorner: at(16, 0),
      right: at(width - 1, 0),
      bottom: at(0, height - 1),
      last: at(width - 1, height - 1),
      middle: at(200, 125),
    };
  });
  assert.deepEqual(shown, {
    size: [400, 250],
    // The corner that was presented by itself, last.
    corner: [255, 255, 255, 255],
    insideCorner: [255, 255, 255, 255],
    // Red grows to the right and green downward; blue is 0x40. Nothing is
    // transparent, whatever the program's fourth bytes said.
    besideCorner: [Math.floor((16 * 255) / 399), 0, 0x40, 255],
    right: [255, 0, 0x40, 255],
    bottom: [0, 255, 0x40, 255],
    last: [255, 255, 0x40, 255],
    middle: [Math.floor((200 * 255) / 399), Math.floor((125 * 255) / 249), 0x40, 255],
  });
  assert.deepEqual(errors, []);
});

test("an input method composes in the window, and commits", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"), ["--text"]);
  await windowOpen(page);
  await page.mouse.click(120, 70);
  await until(page, () => document.activeElement?.tagName === "TEXTAREA");
  // The text field is where the guest said its caret is, so that the input
  // method's own window opens next to it: (10, 20) in the canvas at (20, 20).
  const caret = await page.evaluate(() => {
    const box = document.querySelector("textarea").getBoundingClientRect();
    return [box.left, box.top, box.height];
  });
  assert.deepEqual(caret, [30, 40, 16]);

  // Chrome's own input method interface: a composition, as a keyboard for
  // Japanese would make it, then the text it settles on.
  const browser = await page.context().newCDPSession(page);
  await browser.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await seen(page, "TextComposition w1 \"に\"");
  await browser.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await browser.send("Input.insertText", { text: "日本" });
  await seen(page, "TextCommit w1 \"日本\"");

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const text = output.stdout
    .split("\n")
    .filter((line) => line.startsWith("Text"))
    .join("\n");
  // Offsets are bytes of UTF-8, as everywhere in the API. The composition's
  // last word is the text it settles on; then it is over, and committed.
  assert.equal(
    text,
    `TextInputState w1 state=Active
TextComposition w1 "に" cursor=3..3
TextComposition w1 "にほ" cursor=6..6
TextComposition w1 "日本" cursor=6..6
TextComposition w1 "" cursor=none
TextCommit w1 "日本"`,
  );
  assert.deepEqual(errors, []);
});

test("fingers are pointers of their own", { timeout: 120_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context, { hasTouch: true });
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);
  await page.touchscreen.tap(120, 70);
  await seen(page, "PointerUp ");
  // The canvas has the keyboard after a tap, as after a click.
  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const touches = output.stdout.split("\n").filter((line) => line.includes(" Touch "));
  assert.match(touches[0], /^PointerEnter w1 id=\d+ Touch /, output.stdout);
  assert.ok(
    touches.some((line) => /^PointerDown w1 id=\d+ Touch flags=\S*InContact\S* button=1 buttons=Primary at=100,50 /.test(line)),
    output.stdout,
  );
  assert.ok(touches.some((line) => /^PointerUp w1 id=\d+ Touch /.test(line)), output.stdout);
  // The page does not pan or zoom under a guest's fingers.
  assert.equal(await page.evaluate(() => document.querySelector("#view").style.touchAction), "");
  assert.deepEqual(errors, []);
});

test("a flood of input never makes the page wait", { timeout: 180_000, skip }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const running = run(page, await program("events"));
  await windowOpen(page);
  await page.mouse.click(120, 70);
  // The page's thread reports far more than the guest reads in the time,
  // while the guest's thread reads as fast as it can: the two meet at the
  // queue thousands of times. The page may never wait for the guest there;
  // a browser ends a page thread that tries.
  const sent = await page.evaluate(async () => {
    const view = document.querySelector("#view");
    const box = view.getBoundingClientRect();
    let sent = 0;
    for (let round = 0; round < 40; round++) {
      for (let step = 0; step < 250; step++) {
        const x = box.left + ((round * 7 + step) % 300);
        const y = box.top + ((round * 3 + step) % 200);
        view.dispatchEvent(
          new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, bubbles: true }),
        );
        if (step % 25 === 0) {
          for (const type of ["keydown", "keyup"]) {
            view.dispatchEvent(new KeyboardEvent(type, { code: "KeyK", key: "k", bubbles: true }));
          }
        }
        sent++;
      }
      // Let the worker's messages (there are none to wait for) and the
      // browser breathe.
      await new Promise((done) => setTimeout(done, 0));
    }
    return sent;
  });
  assert.equal(sent, 10_000);

  await page.keyboard.down("F9");
  const output = await running;
  assert.equal(output.exitCode, 0, output.stderr);
  const lines = output.stdout.split("\n");
  const motions = lines.filter((line) => line.startsWith("PointerMotion ")).length;
  const downs = lines.filter((line) => line.startsWith("KeyDown w1 KeyK")).length;
  const ups = lines.filter((line) => line.startsWith("KeyUp w1 KeyK")).length;
  // Motion nobody read in time was merged, not queued; keys never are.
  assert.ok(motions >= 40 && motions <= 10_001, `${motions} motions`);
  assert.equal(downs, 400, output.stdout.slice(0, 2000));
  assert.equal(ups, 400);
  assert.ok(!output.stdout.includes("EventsLost"), "nothing was lost");
  assert.deepEqual(errors, []);
});
