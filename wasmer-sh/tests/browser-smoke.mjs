import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import http from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpmTimeout = Number(process.env.WASMER_PNPM_TIMEOUT ?? 120_000);
const edgejsWebc = process.env.WASMER_EDGEJS_WEBC;
const testPnpm = process.env.WASMER_TEST_PNPM === "1" || Boolean(edgejsWebc);
if (edgejsWebc && !process.env.VITE_EDGEJS_WEBC_URL) {
  process.env.VITE_EDGEJS_WEBC_URL = `/@fs/${edgejsWebc}`;
}
const externalWispUrl = process.env.WASMER_WISP_URL;
const proxy = externalWispUrl
  ? undefined
  : http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("wasmer.sh test WISP proxy");
    });
proxy?.on("upgrade", (request, socket, head) => {
  wisp.routeRequest(request, socket, head);
});

let browser;
let page;
let server;
let serviceWorkerServer;
let serviceWorkerOrigin;
const diagnostics = [];
try {
  serviceWorkerServer = await createServer({
    configFile: fileURLToPath(
      new URL("../service-worker/vite.config.ts", import.meta.url),
    ),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0 },
  });
  await serviceWorkerServer.listen();
  const serviceWorkerAddress = serviceWorkerServer.httpServer?.address();
  assert(serviceWorkerAddress && typeof serviceWorkerAddress !== "string");
  serviceWorkerOrigin = `http://127.0.0.1:${serviceWorkerAddress.port}`;
  process.env.VITE_WASMER_SERVICE_WORKER_ORIGIN = serviceWorkerOrigin;

  server = await createServer({
    root,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: edgejsWebc
        ? { allow: [root, dirname(edgejsWebc)] }
        : undefined,
    },
  });
  if (proxy) {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
  }
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== "string");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("console", (message) =>
    diagnostics.push(`console.${message.type()}: ${message.text()}`),
  );
  page.on("pageerror", (error) =>
    diagnostics.push(`pageerror: ${error.stack ?? error.message}`),
  );

  const proxyAddress = proxy?.address();
  assert(
    externalWispUrl || (proxyAddress && typeof proxyAddress !== "string"),
  );
  const wispUrl =
    externalWispUrl ?? `ws://127.0.0.1:${proxyAddress.port}/`;
  await page.goto(
    `http://127.0.0.1:${address.port}/?wisp=${encodeURIComponent(wispUrl)}`,
    {
      waitUntil: "load",
    },
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.state === "running",
    undefined,
    { timeout: 180_000 },
  );

  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.match(
    await page.locator("#package-name").textContent(),
    /^wasmer\/bash@/,
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 120_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "node -e \"require('dns').lookup('registry.npmjs.org', (error, address) => console.log('__EDGE_DNS_RESULT__', error && error.code, address))\"\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__EDGE_DNS_RESULT__"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  if (testPnpm) {
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send(
        "(cd node-express && pnpm install --ignore-scripts && node -e \"console.log('__PNPM_OK__', require('express/package.json').version)\")\r",
      );
    });
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().includes("\n__PNPM_OK__"),
      undefined,
      { timeout: pnpmTimeout },
    );
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
  }

  if (process.env.WASMER_TEST_WISP_EGRESS === "1") {
    const { address: exampleAddress } = await lookup("example.com", {
      family: 4,
    });
    await page.evaluate(
      async (command) => {
        await globalThis.__wasmerShell.send(command);
      },
      `exec 3<>/dev/tcp/${exampleAddress}/80 && printf 'GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n' >&3 && IFS= read -r line <&3 && printf '__WISP_%s__ %s\\n' OK "$line"; exec 3<&-; exec 3>&-\r`,
    );
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().includes("__WISP_OK__ HTTP/1."),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
  }

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "echo $((6 * 7)) > bash-result.txt\rcat bash-result.txt\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("42"),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "printf '__WASMER_SH_%s__\\n' 'BROWSER_SMOKE'\r",
    );
  });
  await page.waitForFunction(
    () =>
      globalThis.__wasmerShell
        .snapshot()
        .includes("__WASMER_SH_BROWSER_SMOKE__"),
    undefined,
    { timeout: 30_000 },
  );

  await page.waitForFunction(
    () => document.querySelector("#session-status")?.textContent === "Ready",
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("python\r");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes(">>> "),
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("print('PYTHON_' + 'STDIN_OK')\r");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("PYTHON_STDIN_OK"),
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("exit()\r");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("edge\r");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("> "),
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "console.log('EDGE_' + 'STDIN_OK')\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("EDGE_STDIN_OK"),
    undefined,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(".exit\r");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "php -S 0.0.0.0:8000 -t /workspace/php\r",
    );
  });
  await page.locator("#preview-panel").waitFor({ timeout: 60_000 });
  const previewUrl = await page
    .locator("#preview-panel iframe")
    .getAttribute("src");
  assert(previewUrl);
  assert.equal(new URL(previewUrl).origin, serviceWorkerOrigin);
  const previewHost = page.frameLocator("#preview-panel iframe");
  const preview = previewHost.frameLocator("iframe");
  await preview.locator("#php-preview").waitFor({ timeout: 60_000 });
  assert.equal(
    await preview.locator("#php-preview").textContent(),
    "Hello from PHP!",
  );
  await preview.getByRole("link", { name: "View PHP configuration" }).click();
  await page.waitForFunction(
    () => document.querySelector("#preview-location")?.value.endsWith("/phpinfo.php"),
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(await page.locator("#preview-back").isEnabled(), true);
  await page.locator("#preview-back").click();
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#preview-location")?.value === "localhost:8000",
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(await page.locator("#preview-forward").isEnabled(), true);
  await page.locator("#preview-forward").click();
  await page.waitForFunction(
    () => document.querySelector("#preview-location")?.value.endsWith("/phpinfo.php"),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("#preview-back").click();
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await page.locator("#preview-location").fill("localhost:8000/phpinfo.php");
  await page.locator("#preview-location").press("Enter");
  await page.waitForFunction(
    () => document.querySelector("#preview-location")?.value.endsWith("/phpinfo.php"),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("#preview-back").click();
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await page.locator("#preview-refresh").click();
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("\x03");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("#preview-panel").waitFor({
    state: "hidden",
    timeout: 30_000,
  });

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("node node/server.js\r");
  });
  await page.locator("#preview-panel").waitFor({ timeout: 60_000 });
  const nodePreview = page
    .frameLocator("#preview-panel iframe")
    .frameLocator("iframe");
  await nodePreview.locator("#node-preview").waitFor({ timeout: 60_000 });
  assert.equal(
    await nodePreview.locator("#node-preview").textContent(),
    "Hello from Node.js!",
  );
  await nodePreview
    .locator("#node-health")
    .filter({ hasText: "/health is ready" })
    .waitFor({ timeout: 30_000 });
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("\x03");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("#preview-panel").waitFor({
    state: "hidden",
    timeout: 30_000,
  });

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("python python/server.py\r");
  });
  await page.locator("#preview-panel").waitFor({ timeout: 60_000 });
  const pythonPreview = page
    .frameLocator("#preview-panel iframe")
    .frameLocator("iframe");
  await pythonPreview.locator("#python-preview").waitFor({ timeout: 60_000 });
  assert.equal(
    await pythonPreview.locator("#python-preview").textContent(),
    "Hello from Python!",
  );
  await pythonPreview
    .locator("#python-health")
    .filter({ hasText: "/health is ready" })
    .waitFor({ timeout: 30_000 });
  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send("\x03");
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("#preview-panel").waitFor({
    state: "hidden",
    timeout: 30_000,
  });

  console.log("wasmer.sh browser smoke test passed");
} catch (error) {
  console.error(error);
  if (page) {
    console.error(
      "shell state:",
      await page
        .evaluate(() => ({
          state: globalThis.__wasmerShell?.state(),
          transcript: globalThis.__wasmerShell?.snapshot(),
          status: document.querySelector("#session-status")?.textContent,
        }))
        .catch(() => undefined),
    );
  }
  if (diagnostics.length > 0) {
    console.error(diagnostics.join("\n"));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await serviceWorkerServer?.close();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
}
