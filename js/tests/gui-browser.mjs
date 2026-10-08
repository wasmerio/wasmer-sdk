// What the browser tests of guest windows share: a cross-origin isolated
// page that can import the SDK, a sandbox whose default window is a canvas of
// that page, and ways to wait for what the guest prints and the page shows.
//
// By default the installed Chrome is used, in its new headless mode; set
// WASMER_GUI_BROWSER_CHANNEL (a Playwright channel, or "bundled" for
// Playwright's own Chromium) to use another one.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const PAGE = `<!doctype html>
<title>GUI test</title>
<style>
  body { margin: 0; }
  #view { display: block; margin: 20px; width: 300px; height: 200px; }
</style>
<canvas id="view"></canvas>
<canvas id="second" style="display: block; width: 100px; height: 50px"></canvas>`;

/**
 * A cross-origin isolated page that can import the SDK. `html` is what it
 * holds: by default a canvas `#view` of 300 by 200 at (20, 20), and a second
 * one.
 */
export async function openPage(context, device = {}, html = PAGE) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
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
  const channel = process.env.WASMER_GUI_BROWSER_CHANNEL ?? "chrome";
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
        // A page in the background gets no animation frames, which is what
        // a guest that asked to redraw waits for.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ],
    });
  } catch (error) {
    return { unavailable: `the browser (${channel}) could not be started: ${error.message.split("\n")[0]}` };
  }
  const browserContext = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    // Copying asks nobody; what is read is still up to the sandbox's policy.
    permissions: ["clipboard-read", "clipboard-write"],
    ...device,
  });
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return { page, errors };
}

/**
 * Runs one program in a sandbox whose default window is `#view`. What it
 * prints is also kept in the page line by line as it comes (`seen` below),
 * for a test to wait on.
 */
export function run(page, bytes, args = [], gui = {}) {
  return page.evaluate(
    async ({ bytes, args, gui }) => {
      const { Wasmer } = await import("/dist/index.js");
      const client = new Wasmer({ cache: false });
      const lines = (globalThis.__lines = []);
      let sandbox;
      try {
        const pkg = await client.packages.load(new Uint8Array(bytes));
        sandbox = await client.sandboxes.create({
          packages: [pkg],
          gui: { canvas: document.querySelector("#view"), ...gui },
        });
        const process = await sandbox.command(pkg, args).spawn({ stdout: "pipe" });
        for await (const line of process.stdout.lines()) lines.push(line);
        const output = await process.wait({ check: false });
        return {
          exitCode: output.exitCode,
          stdout: lines.map((line) => `${line}\n`).join(""),
          stderr: output.stderr.text(),
        };
      } finally {
        await sandbox?.close();
        await client.close();
      }
    },
    { bytes, args, gui },
  );
}

/** Resolves once the program has printed a line that starts with `text`. */
export function seen(page, text) {
  return page.waitForFunction(
    (text) => (globalThis.__lines ?? []).some((line) => line.startsWith(text)),
    text,
    { timeout: 15_000, polling: 10 },
  );
}

/** Resolves once `predicate` (run in the page) holds. */
export function until(page, predicate, argument) {
  return page.waitForFunction(predicate, argument, { timeout: 15_000, polling: 20 });
}
