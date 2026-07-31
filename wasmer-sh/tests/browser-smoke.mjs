import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  logLevel: "warn",
  server: {
    host: "127.0.0.1",
    port: 0,
  },
});

let browser;
let page;
const diagnostics = [];
try {
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

  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "load",
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.state === "running",
    undefined,
    { timeout: 180_000 },
  );

  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.match(
    await page.locator("#package-name").textContent(),
    /^sharrattj\/bash@/,
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "printf '__WASMER_SH_%s__\\n' 'BROWSER_SMOKE'\n",
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
  await server.close();
}
