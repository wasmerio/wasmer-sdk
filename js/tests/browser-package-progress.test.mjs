import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "./support/browser-servers.mjs";

test("browser package streams, shared cancellation and cache hits", { timeout: 90_000 }, async context => {
  const server = await startAppServer();
  const browser = await chromium.launch({ headless: true });
  context.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url);
  const result = await page.evaluate(async () => {
    const { Wasmer } = await import("/dist/index.js");
    const originalFetch = globalThis.fetch.bind(globalThis);
    let transfers = 0, aborted = 0;
    // Use a real registry image, but split its body over time so this test
    // verifies progress rather than depending on network packet timing.
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/webcimages/")) return response;
      transfers++;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const signal = options?.signal ?? input.signal;
      let offset = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 120));
          if (signal?.aborted) { aborted++; controller.error(signal.reason); return; }
          if (offset === bytes.length) { controller.close(); return; }
          const end = Math.min(bytes.length, offset + Math.ceil(bytes.length / 5));
          controller.enqueue(bytes.slice(offset, end)); offset = end;
        },
      });
      return new Response(stream, { status: response.status });
    };
    const client = new Wasmer({ cache: false });
    try {
      const a = [], b = [];
      const abort = new AbortController();
      const first = client.packages.load("wasmer/hello-world@0.2.5", {
        signal: abort.signal,
        onProgress(p) { a.push(p); if (p.download.downloadedBytes > 0) abort.abort(); },
      }).then(() => "unexpected success", e => e.name);
      const second = client.packages.load("wasmer/hello-world@0.2.5", { onProgress: p => b.push(p) });
      const [cancelled, pkg] = await Promise.all([first, second]);
      const cached = [];
      await client.packages.load("wasmer/hello-world@0.2.5", { onProgress: p => cached.push(p) });
      const warmTransfers = transfers;
      const cancelledClient = new Wasmer({ cache: false });
      try {
        const last = new AbortController();
        await cancelledClient.packages.load("wasmer/hello-world@0.2.5", {
          signal: last.signal,
          onProgress(p) { if (p.download.downloadedBytes > 0) last.abort(); },
        }).then(() => { throw new Error("unexpected success"); }, e => { if (e.name !== "AbortError") throw e; });
        await new Promise(resolve => setTimeout(resolve, 400));
      } finally { await cancelledClient.close(); }
      return { cancelled, a, b, cached, warmTransfers, transfers, aborted, id: pkg.id };
    } finally { await client.close(); globalThis.fetch = originalFetch; }
  });
  assert.equal(result.cancelled, "AbortError");
  assert.equal(result.warmTransfers, 1, "overlapping and cached calls reuse the image");
  assert.equal(result.transfers, 2);
  assert.equal(result.aborted, 1, "last subscriber cancellation aborts Fetch");
  assert(result.a.every(p => p.phase !== "ready"));
  const final = result.b.at(-1);
  assert.equal(final.phase, "ready");
  assert.equal(final.download.percent, 100);
  assert(result.b.some(p => p.download.downloadedBytes > 0 && p.download.downloadedBytes < final.download.downloadedBytes));
  assert.equal(result.cached.at(-1).packages[0].cached, true);
  assert.deepEqual(result.cached.at(-1).download, { downloadedBytes: 0, totalBytes: 0, percent: 100 });
});
