import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import { startAppServer } from "./support/browser-servers.mjs";

const browsers = { chromium, firefox, webkit };
for (const name of (process.env.WASMER_TEST_BROWSERS ?? "chromium,firefox,webkit").split(",")) {
  test(`package downloads preserve the browser User-Agent in ${name}`, { timeout: 30_000 }, async context => {
    const app = await startAppServer();
    context.after(() => app.close());
    const requests = [];
    const cdn = createServer((request, response) => {
      requests.push({ method: request.method, userAgent: request.headers["user-agent"] });
      response.setHeader("Access-Control-Allow-Origin", new URL(app.url).origin);
      // Like a static package CDN, allow a simple GET but reject preflights.
      // A 404 proves the browser received the response without needing a WebC.
      response.writeHead(request.method === "GET" ? 404 : 403).end("Package not found");
    });
    await new Promise(resolve => cdn.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise(resolve => { cdn.closeAllConnections(); cdn.close(resolve); }));
    const browser = await browsers[name].launch({ headless: true });
    context.after(() => browser.close());
    const page = await browser.newPage();
    const distribution = {
      webcManifest: JSON.stringify({ package: { wapm: { name: "sdk-test/cors", version: "1.0.0" } } }),
      piritaDownloadUrl: `http://127.0.0.1:${cdn.address().port}/missing.webc`,
      piritaSha256Hash: "0".repeat(64),
    };
    await page.route("https://registry.wasmer.io/graphql", route => route.fulfill({
      json: { data: {
        getPackage: { packageName: "cors", namespace: "sdk-test", versions: [{
          version: "1.0.0", isArchived: false, v2: distribution, v3: distribution,
        }] },
        info: { defaultFrontend: "https://wasmer.io/" },
      } },
    }));
    await page.goto(app.url);
    const result = await page.evaluate(async () => {
      const { Wasmer } = await import("/dist/index.js");
      const client = new Wasmer({ cache: false });
      try {
        await client.packages.load("sdk-test/cors@1.0.0");
        throw new Error("Unexpected package load success");
      } catch (error) {
        return { message: error.message, userAgent: navigator.userAgent };
      } finally { await client.close(); }
    });
    assert.match(result.message, /404/, "the SDK should receive the CDN response, not a CORS failure");
    assert.deepEqual(requests, [{ method: "GET", userAgent: result.userAgent }]);
  });
}
