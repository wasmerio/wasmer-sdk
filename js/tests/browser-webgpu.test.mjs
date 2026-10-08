// WebGPU for guests, end to end in a browser: C programs built against
// webgpu.h (packages/webgpu/tests/programs) run in SDK workers on the
// browser's GPU, and present to a canvas of the page.
//
// The programs are the conformance suite of packages/webgpu; build them with
// packages/webgpu/tests/build-test-wasix.sh. The test needs a browser with a
// WebGPU adapter: by default the installed Chrome, in its new headless mode.
// Set WASMER_WEBGPU_BROWSER_CHANNEL (a Playwright channel, or "bundled" for
// Playwright's own Chromium) to use another one.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const webgpu = new URL("../../packages/webgpu/", import.meta.url);
const programs = new URL("tests/programs/out/", webgpu);
const built = existsSync(new URL("compute_double.wasm", programs));
// Without the programs (or the submodule they come from) every test skips.
const manifest = built
  ? JSON.parse(await readFile(new URL("tests/manifest.json", webgpu), "utf8"))
  : { tests: [] };
const expected = new Map(manifest.tests.map((entry) => [entry.name, entry]));

async function program(name) {
  return [...(await readFile(new URL(`${name}.wasm`, programs)))];
}

/** A cross-origin isolated page that can import the SDK, in a browser with a GPU. */
async function openPage(context) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>WebGPU test</title><canvas id="view" width="64" height="48"></canvas>',
      );
      return;
    }
    const file = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${resolve(root)}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        extname(file) === ".wasm" ? "application/wasm" : "text/javascript",
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const channel = process.env.WASMER_WEBGPU_BROWSER_CHANNEL ?? "chrome";
  let browser;
  context.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  try {
    browser = await chromium.launch({
      headless: true,
      ...(channel === "bundled" ? {} : { channel }),
      args: [
        // A page in the background gets no animation frames, which is what a
        // presenting guest waits for.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ],
    });
  } catch (error) {
    return { unavailable: `the browser (${channel}) could not be started: ${error.message.split("\n")[0]}` };
  }
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const adapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (!adapter) return { unavailable: "this browser has no WebGPU adapter" };
  return { page, errors };
}

/** Reads the pixel in the middle of a page canvas as the page shows it. */
const CENTER_PIXEL = `(canvas) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext("2d");
  context.drawImage(canvas, 0, 0, copy.width, copy.height);
  return [...context.getImageData(copy.width >> 1, copy.height >> 1, 1, 1).data];
}`;

test("webgpu.h programs run on the browser's GPU", { timeout: 240_000, skip: !built && "build packages/webgpu/tests first" }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  // Everything except the programs that need a canvas, which the next test runs.
  const names = manifest.tests
    .filter((entry) => entry.browser !== false && entry.name !== "surface")
    .map((entry) => entry.name);
  const modules = {};
  for (const name of names) modules[name] = await program(name);

  const outputs = await page.evaluate(async (modules) => {
    const { Wasmer } = await import("/dist/index.js");
    const client = new Wasmer({ cache: false });
    const outputs = {};
    let sandbox;
    try {
      sandbox = await client.sandboxes.create({ webgpu: true });
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
    } finally {
      await sandbox?.close();
      await client.close();
    }
    return outputs;
  }, modules);

  for (const name of names) {
    const output = outputs[name];
    assert.equal(output.stdout, expected.get(name).stdout, `${name}: ${output.stderr}`);
    assert.equal(output.exitCode, 0, `${name}: ${output.stderr}`);
  }
  assert.deepEqual(errors, []);
});

test("a guest presents to a canvas of the page", { timeout: 120_000, skip: !built && "build packages/webgpu/tests first" }, async (context) => {
  const { page, errors, unavailable } = await openPage(context);
  if (unavailable) return context.skip(unavailable);

  const result = await page.evaluate(
    async ({ surface, centerPixel }) => {
      const { Wasmer } = await import("/dist/index.js");
      const pixel = (0, eval)(centerPixel);
      const view = document.querySelector("#view");
      const client = new Wasmer({ cache: false });
      const result = {};
      let sandbox;
      try {
        const pkg = await client.packages.load(new Uint8Array(surface));

        // An element stays with the page, so two commands can draw to it.
        sandbox = await client.sandboxes.create({ packages: [pkg], webgpu: { canvas: view } });
        result.enabled = sandbox.webgpu.enabled;
        result.first = (await sandbox.command(pkg).run()).text();
        result.second = (await sandbox.command(pkg).run()).text();
        // Frames travel through this thread's message queue: let them land.
        await new Promise((done) => setTimeout(done, 100));
        result.element = pixel(view);
        result.elementSize = [view.width, view.height];

        // A selector nobody granted has no canvas: the guest gets no surface.
        sandbox.webgpu.setCanvas(undefined);
        const refused = await sandbox.command(pkg).run({ check: false });
        result.refused = { ok: refused.ok, stderr: refused.stderr.text() };

        // An OffscreenCanvas moves to the guest, which presents on its own.
        const direct = document.createElement("canvas");
        direct.width = 32;
        direct.height = 32;
        document.body.append(direct);
        sandbox.webgpu.setCanvas(direct.transferControlToOffscreen(), "#canvas");
        result.direct = (await sandbox.command(pkg).run()).text();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        result.offscreen = pixel(direct);

        // A function is asked when a guest creates a surface, and for which.
        await sandbox.close();
        const asked = [];
        const lazy = document.createElement("canvas");
        lazy.width = 16;
        lazy.height = 16;
        let answer = lazy;
        sandbox = await client.sandboxes.create({
          packages: [pkg],
          webgpu: {
            canvas: (selector) => {
              asked.push(selector);
              return answer;
            },
          },
        });
        result.provided = (await sandbox.command(pkg).run()).text();
        await new Promise((done) => setTimeout(done, 100));
        result.providedPixel = pixel(lazy);
        answer = undefined;
        result.providedNothing = (await sandbox.command(pkg).run({ check: false })).ok;
        result.asked = asked;
      } finally {
        await sandbox?.close();
        await client.close();
      }

      // Without the grant the program's imports are missing: it cannot start.
      const plain = new Wasmer({ cache: false });
      try {
        const pkg = await plain.packages.load(new Uint8Array(surface));
        const ungranted = await plain.sandboxes.create({ packages: [pkg] });
        try {
          result.ungrantedEnabled = ungranted.webgpu.enabled;
          const output = await ungranted.command(pkg).run({ check: false });
          result.ungranted = output.ok;
        } catch (error) {
          result.ungranted = String(error?.message ?? error);
        } finally {
          await ungranted.close();
        }
      } finally {
        await plain.close();
      }
      return result;
    },
    { surface: await program("surface"), centerPixel: CENTER_PIXEL },
  );

  const stdout = expected.get("surface").stdout;
  assert.equal(result.enabled, true);
  assert.equal(result.first, stdout);
  assert.equal(result.second, stdout);
  // The program's last frame is blue, and the page's canvas keeps its size.
  assert.deepEqual(result.element, [0, 0, 255, 255]);
  assert.deepEqual(result.elementSize, [64, 48]);
  assert.equal(result.refused.ok, false, result.refused.stderr);
  assert.equal(result.direct, stdout);
  assert.deepEqual(result.offscreen, [0, 0, 255, 255]);
  assert.equal(result.provided, stdout);
  assert.deepEqual(result.providedPixel, [0, 0, 255, 255]);
  assert.equal(result.providedNothing, false);
  // The program makes its surface twice; the second run stops at the first.
  assert.deepEqual(result.asked, ["#canvas", "#canvas", "#canvas"]);
  assert.equal(result.ungrantedEnabled, false);
  assert.notEqual(result.ungranted, true);
  assert.deepEqual(errors, []);
});
