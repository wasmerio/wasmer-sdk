import assert from "node:assert/strict";
import http from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const timeout = Number(process.env.WASMER_NEXT_TIMEOUT ?? 360_000);
const startedAt = performance.now();
const edgejsWebc = process.env.WASMER_EDGEJS_WEBC;
const edgejsPackage = process.env.WASMER_NEXT_EDGEJS_PACKAGE;
const splitInstall = process.env.WASMER_PNPM_SPLIT === "1";
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
let rejectNapiFailure;
const napiFailure = new Promise((_, reject) => {
  rejectNapiFailure = reject;
});
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
    if (message.type() !== "error") return;
    console.error("browser:", message.text());
    if (message.text().includes("[wasmer-napi-callback]")) {
      rejectNapiFailure(new Error(message.text()));
    }
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
  const shellUrl = new URL(`http://127.0.0.1:${appAddress.port}/`);
  shellUrl.searchParams.set("wisp", wispUrl);
  if (edgejsPackage) shellUrl.searchParams.set("use", edgejsPackage);
  await page.goto(
    shellUrl.href,
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => ["running", "error"].includes(document.documentElement.dataset.state ?? ""),
    undefined,
    { timeout },
  );
  const startupState = await page.evaluate(() => document.documentElement.dataset.state);
  if (startupState !== "running") {
    throw new Error(`wasmer.sh failed to start: ${await page.locator("body").innerText()}`);
  }
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout },
  );
  const shellReadyAt = performance.now();

  let rejectPreviewResponse;
  const previewResponseFailure = new Promise((_, reject) => {
    rejectPreviewResponse = reject;
  });
  page.on("response", async (response) => {
    if (response.status() < 500) return;
    rejectPreviewResponse(
      new Error(
        `preview request failed: ${response.status()} ${response.url()} ${await response.text().catch(() => "")}`,
      ),
    );
  });

  await page.evaluate(async ({ splitInstall }) => {
    const fetch = "pnpm fetch --frozen-lockfile --ignore-scripts";
    const install = splitInstall
      ? `${fetch} && echo __WASMER_FETCH_DONE__ && pnpm install --offline --frozen-lockfile --ignore-scripts`
      : "pnpm install --frozen-lockfile --ignore-scripts";
    await globalThis.__wasmerShell.send(
      `cd next && ${install} && echo __WASMER_INSTALL_DONE__ && pnpm dev\r`,
    );
  }, { splitInstall });
  let fetchDoneAt;
  if (splitInstall) {
    const fetchStateHandle = await Promise.race([
      page.waitForFunction(
        () => {
          const transcript = globalThis.__wasmerShell.snapshot().replace(/\r/g, "");
          if (/(?:^|\n)__WASMER_FETCH_DONE__(?:\n|$)/.test(transcript)) return "done";
          if (/\n[^\n]*next[^\n]*\$\s*$/.test(transcript)) return "failed";
          return false;
        },
        undefined,
        { timeout },
      ),
      napiFailure,
    ]);
    const fetchState = await fetchStateHandle.jsonValue();
    if (fetchState !== "done") {
      throw new Error(
        `pnpm fetch returned before completing:\n${await page.evaluate(
          () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, ""),
        )}`,
      );
    }
    fetchDoneAt = performance.now();
  }
  await Promise.race([
    page.waitForFunction(
      () => /(?:^|\n)__WASMER_INSTALL_DONE__(?:\n|$)/.test(
        globalThis.__wasmerShell
          .snapshot()
          .replace(/\x1b\[[0-9;]*m/g, "")
          .replace(/\r/g, ""),
      ),
      undefined,
      { timeout },
    ),
    napiFailure,
  ]);
  const installDoneAt = performance.now();
  const devStateHandle = await Promise.race([
    page.waitForFunction(
      () => {
        const transcript = globalThis.__wasmerShell
          .snapshot()
          .replace(/\x1b\[[0-9;]*m/g, "");
        if (/(?:^|\n)\s*(?:✓\s*)?Ready in \d+(?:\.\d+)?(?:ms|s)\s*(?:\n|$)/.test(transcript)) {
          return "ready";
        }
        // The combined install/dev command can fail and return to the shell.
        // Surface that terminal state immediately instead of waiting for the
        // unrelated readiness timeout to expire.
        if (transcript.includes("pnpm install --frozen-lockfile") &&
            /\n[^\n]*next[^\n]*\$\s*$/.test(transcript)) {
          return "failed";
        }
        return false;
      },
      undefined,
      { timeout },
    ),
    napiFailure,
  ]);
  const devState = await devStateHandle.jsonValue();
  if (devState !== "ready") {
    throw new Error(
      `pnpm install/dev returned before Next.js was ready:\n${await page.evaluate(
        () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, ""),
      )}`,
    );
  }
  const devReadyAt = performance.now();
  await page.locator("#preview-panel").waitFor({ timeout });
  const preview = page.frameLocator("#preview-panel iframe").frameLocator("iframe");
  const shellRuntimeFailure = page.evaluate(() => new Promise((_, reject) => {
    const timer = setInterval(() => {
      const transcript = globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "");
      if (!/ERR_INVALID_ARG_TYPE|\[wasmer-napi-callback\]|\[callback trampoline\]/.test(transcript)) {
        return;
      }
      clearInterval(timer);
      reject(new Error(`guest runtime failed:\n${transcript}`));
    }, 100);
  }));
  await Promise.race([
    preview.getByText("Welcome to Next.js on Wasmer.", { exact: true }).waitFor({ timeout }),
    previewResponseFailure,
    shellRuntimeFailure,
    napiFailure,
  ]);

  console.log(
    "Next.js browser regression test passed",
    JSON.stringify({
      shellReadyMs: Math.round(shellReadyAt - startedAt),
      fetchMs: fetchDoneAt === undefined ? undefined : Math.round(fetchDoneAt - shellReadyAt),
      offlineInstallMs: fetchDoneAt === undefined ? undefined : Math.round(installDoneAt - fetchDoneAt),
      installMs: Math.round(installDoneAt - shellReadyAt),
      devReadyMs: Math.round(devReadyAt - installDoneAt),
      previewReadyMs: Math.round(performance.now() - devReadyAt),
      totalMs: Math.round(performance.now() - startedAt),
    }),
  );
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
