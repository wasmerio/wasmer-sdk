import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

test("creates and asynchronously compiles a large browser package with bundled files", { timeout: 60_000 }, async (context) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Package test</title>");
      return;
    }
    const file = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${resolve(root)}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader("Content-Type", extname(file) === ".wasm" ? "application/wasm" : "text/javascript");
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let browser;
  context.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const fixture = await readFile(new URL("../../rust/tests/fixtures/package-files.wasm", import.meta.url));
  const result = await page.evaluate(async (fixture) => {
    const { Wasmer } = await import("/dist/index.js");
    // A valid custom section takes the guest over Chromium's sync compilation
    // limit while keeping runtime execution small and deterministic.
    const sectionSize = 9 * 1024 * 1024;
    const header = [0];
    for (let value = sectionSize; ; value >>>= 7) {
      header.push((value & 127) | (value > 127 ? 128 : 0));
      if (value <= 127) break;
    }
    const bytes = new Uint8Array(fixture.length + header.length + sectionSize);
    bytes.set(fixture);
    bytes.set(header, fixture.length);
    // The section's first zero is its empty-name length; the rest is payload.
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      const pkg = await client.packages.create({
        modules: { app: bytes }, commands: { hello: { module: "app" } },
        files: { "/data/input.txt": "browser data" },
      });
      sandbox = await client.sandboxes.create({ packages: [pkg] });
      const first = (await sandbox.command(pkg).run()).text();
      const second = (await sandbox.command("hello").run()).text();
      return { first, second, isolated: crossOriginIsolated };
    } finally {
      await sandbox?.close();
      await client.close();
    }
  }, [...fixture]);
  assert.deepEqual(result, { first: "browser data", second: "browser data", isolated: true });
  assert.deepEqual(errors, []);
});
