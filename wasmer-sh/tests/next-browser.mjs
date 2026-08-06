import assert from "node:assert/strict";
import http from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const timeout = Number(process.env.WASMER_NEXT_TIMEOUT ?? 360_000);
const edgejsWebc = process.env.WASMER_EDGEJS_WEBC;
if (edgejsWebc) process.env.VITE_EDGEJS_WEBC_URL = `/@fs/${edgejsWebc}`;

const proxy = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("wasmer.sh test WISP proxy");
});
proxy.on("upgrade", (request, socket, head) => {
  wisp.routeRequest(request, socket, head);
});

let browser;
let page;
let appServer;
let httpHost;
try {
  httpHost = await createServer({
    configFile: fileURLToPath(new URL("../service-worker/vite.config.ts", import.meta.url)),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0 },
  });
  await httpHost.listen();
  const httpAddress = httpHost.httpServer?.address();
  assert(httpAddress && typeof httpAddress !== "string");
  process.env.VITE_WASMER_SERVICE_WORKER_ORIGIN = `http://127.0.0.1:${httpAddress.port}`;

  appServer = await createServer({
    root,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: edgejsWebc ? { allow: [root, dirname(edgejsWebc)] } : undefined,
    },
  });
  await appServer.listen();
  const appAddress = appServer.httpServer?.address();
  assert(appAddress && typeof appAddress !== "string");

  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error("browser:", message.text());
  });
  page.on("response", async (response) => {
    if (response.status() < 400) return;
    console.error("http:", response.status(), response.url(), await response.text().catch(() => ""));
  });
  page.on("requestfailed", (request) => {
    console.error("request failed:", request.url(), request.failure());
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.loadingFailed", (event) => {
    if (event.blockedReason || event.corsErrorStatus) console.error("network failure:", event);
  });

  const wispUrl = `ws://127.0.0.1:${proxyAddress.port}/`;
  await page.goto(
    `http://127.0.0.1:${appAddress.port}/?wisp=${encodeURIComponent(wispUrl)}`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.state === "running",
    undefined,
    { timeout },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "cd next && pnpm install --frozen-lockfile --ignore-scripts && pnpm dev\r",
    );
  });
  await page.waitForFunction(
    () => /(?:^|\n)\s*(?:✓\s*)?Ready in \d+(?:\.\d+)?(?:ms|s)\s*(?:\n|$)/.test(
      globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, ""),
    ),
    undefined,
    { timeout },
  );
  await page.locator("#preview-panel").waitFor({ timeout });
  const preview = page.frameLocator("#preview-panel iframe").frameLocator("iframe");
  await preview.getByText("Welcome to Next.js on Wasmer.", { exact: true }).waitFor({ timeout });

  console.log("Next.js browser regression test passed");
} catch (error) {
  console.error(error);
  if (page) {
    console.error("transcript:", await page.evaluate(() => globalThis.__wasmerShell?.snapshot()).catch(() => ""));
    console.error("frames:", await Promise.all(page.frames().map(async (frame) => ({
      url: frame.url(),
      body: await frame.locator("body").innerText().catch(() => ""),
    }))));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await appServer?.close();
  await httpHost?.close();
  await new Promise((resolve) => proxy.close(resolve));
}
