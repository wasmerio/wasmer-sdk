import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "./support/browser-servers.mjs";

test("raw module loading uses native digests, preserves snapshots, and falls back", { timeout: 60_000 }, async context => {
  const server = await startAppServer();
  const browser = await chromium.launch({ headless: true });
  context.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url);
  const bytes = await readFile(new URL("../../swift/Tests/WasmerSDKTests/Fixtures/hello.wasm", import.meta.url));
  const result = await page.evaluate(async bytes => {
    const { Wasmer } = await import("/dist/index.js");
    const { hashBrowserModule, WasmerCore, PackageLoadCancellation } = await import("/pkg/wasmer_sdk_js.js");
    const nativeDigest = crypto.subtle.digest;
    const client = new Wasmer({ cache: false });
    let sandbox, calls = 0;
    const ids = [];
    try {
      crypto.subtle.digest = function (...args) { calls++; return nativeDigest.apply(this, args); };
      const input = new Uint8Array(bytes);
      const pending = client.packages.load(input);
      input.fill(0);
      const native = await pending;
      ids.push(native.id);
      sandbox = await client.sandboxes.create({ packages: [native] });
      const text = (await sandbox.command(native).run()).text();
      const nativeCalls = calls;
      for (const fallback of [
        undefined,
        () => { throw new Error("unavailable"); },
        () => Promise.reject(new Error("unavailable")),
        () => Promise.resolve("invalid result"),
      ]) {
        crypto.subtle.digest = fallback;
        ids.push((await client.packages.load(new Uint8Array(bytes))).id);
      }
      const rawHash = hashBrowserModule(new Uint8Array(bytes));
      let batchStarted;
      const batchWaiting = new Promise(resolve => { batchStarted = resolve; });
      crypto.subtle.digest = function (...args) {
        batchStarted();
        const digest = nativeDigest.apply(this, args);
        return new Promise(resolve => setTimeout(() => resolve(digest), 20));
      };
      const core = WasmerCore.create({});
      const batchToken = new PackageLoadCancellation();
      let batch;
      try {
        const first = new Uint8Array(bytes), second = new Uint8Array(bytes);
        const loading = core.loadPackages([first, second], undefined, batchToken);
        await batchWaiting;
        second.fill(0);
        batch = await loading;
        if (batch[0].id !== native.id || batch[1].id !== native.id) throw new Error("batch inputs changed while awaiting a digest");
      } finally {
        for (const pkg of batch ?? []) pkg.free();
        batchToken.free();
        await core.shutdown();
      }
      let started;
      const waiting = new Promise(resolve => { started = resolve; });
      crypto.subtle.digest = () => { started(); return new Promise(() => {}); };
      const controller = new AbortController();
      const cancelled = client.packages.load(new Uint8Array(bytes), { signal: controller.signal })
        .then(() => "unexpected success", error => error.name);
      await waiting;
      controller.abort();
      const cancellation = await Promise.race([
        cancelled,
        new Promise((_, reject) => setTimeout(() => reject(new Error("digest cancellation stalled")), 2000)),
      ]);
      return { ids, nativeCalls, text, rawHash, cancellation };
    } finally {
      crypto.subtle.digest = nativeDigest;
      await sandbox?.close();
      await client.close();
    }
  }, [...bytes]);
  assert.equal(result.nativeCalls, 1);
  assert.equal(new Set(result.ids).size, 1);
  assert.equal(result.text, "Hello from Swift!\n");
  assert.equal(result.rawHash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.cancellation, "AbortError");
});
