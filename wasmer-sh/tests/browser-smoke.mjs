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
const nextTimeout = Number(process.env.WASMER_NEXT_TIMEOUT ?? 240_000);
const vinextTimeout = Number(process.env.WASMER_VINEXT_TIMEOUT ?? 720_000);
const edgejsWebc = process.env.WASMER_EDGEJS_WEBC;
const testPnpm = process.env.WASMER_TEST_PNPM === "1" || Boolean(edgejsWebc);
const testNext = process.env.WASMER_TEST_NEXT === "1";
const testNextBuild = process.env.WASMER_TEST_NEXT_BUILD === "1";
const testVinext = process.env.WASMER_TEST_VINEXT === "1";
const testVinextDev = process.env.WASMER_TEST_VINEXT_DEV === "1";
const testPython = process.env.WASMER_TEST_PYTHON !== "0";
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
  if (testVinext || testVinextDev) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
        configurable: true,
        get: () => 4,
      });
    });
  }
  await page.addInitScript(() => {
    globalThis.addEventListener("error", (event) => {
      console.error("[wasmer-sh-debug-error]", event.error?.stack ?? event.message);
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      console.error("[wasmer-sh-debug-rejection]", event.reason?.stack ?? event.reason);
    });
  });
  page.on("console", (message) =>
    (diagnostics.push(`console.${message.type()}: ${message.text()}`),
    message.text().startsWith("[wasmer-sh-debug-") && console.error(message.text())),
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

  if (testVinextDev) {
    const startedAt = Date.now();
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send(
        "cd vinext && pnpm install --frozen-lockfile --ignore-scripts && pnpm run dev\r",
      );
    });
    await page.locator("#preview-panel").waitFor({ timeout: 120_000 });
    const vinextPreview = page
      .frameLocator("#preview-panel iframe")
      .frameLocator("iframe");
    await vinextPreview
      .getByText("Welcome to Vinext on Wasmer.", { exact: true })
      .waitFor({ timeout: vinextTimeout });
    console.log(`wasmer.sh Vinext dev rendered in ${Date.now() - startedAt}ms`);
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("\x03");
    });
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
  } else if (testVinext) {
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send(
        "(cd vinext && pnpm install --frozen-lockfile --ignore-scripts && pnpm build && echo __VINEXT_BUILD_OK__) || echo __VINEXT_BUILD_FAILED__:$?\r",
      );
    });
    await page.waitForFunction(
      () => /\n__VINEXT_BUILD_(?:OK|FAILED__:\d+)/.test(globalThis.__wasmerShell.snapshot()),
      undefined,
      { timeout: vinextTimeout },
    );
    assert.doesNotMatch(
      await page.evaluate(() => globalThis.__wasmerShell.snapshot()),
      /\n__VINEXT_BUILD_FAILED__:/,
    );
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("cd vinext && pnpm start\r");
    });
    await page.locator("#preview-panel").waitFor({ timeout: 120_000 });
    const vinextPreview = page
      .frameLocator("#preview-panel iframe")
      .frameLocator("iframe");
    await vinextPreview
      .getByText("Welcome to Vinext on Wasmer.", { exact: true })
      .waitFor({ timeout: 120_000 });
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("\x03");
    });
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
    console.log("wasmer.sh Vinext browser build passed");
  } else {
  assert.equal(await page.locator("#editor-panel").isHidden(), true);
  await page.locator("#editor-button").click();
  await page.waitForFunction(
    () => document.querySelector("#editor-panel")?.dataset.ready === "true",
    undefined,
    { timeout: 90_000 },
  );
  const editorLayout = await page.evaluate(() => {
    const explorer = document.querySelector(".editor-explorer")?.getBoundingClientRect();
    const editor = document.querySelector(".editor-main")?.getBoundingClientRect();
    const terminal = document.querySelector(".terminal-frame")?.getBoundingClientRect();
    if (!explorer || !editor || !terminal) return undefined;
    return {
      explorerRight: explorer.right,
      explorerBottom: explorer.bottom,
      editorLeft: editor.left,
      terminalLeft: terminal.left,
      terminalBottom: terminal.bottom,
    };
  });
  assert.ok(editorLayout);
  assert.ok(Math.abs(editorLayout.editorLeft - editorLayout.terminalLeft) < 1);
  assert.ok(Math.abs(editorLayout.explorerRight - editorLayout.editorLeft) < 1);
  assert.ok(Math.abs(editorLayout.explorerBottom - editorLayout.terminalBottom) < 1);
  const workspaceReadme = page.locator(
    '#editor-tree .editor-tree-row[data-path="README.md"]',
  );
  await workspaceReadme.waitFor({ timeout: 30_000 });
  await workspaceReadme.click();
  assert.match(await workspaceReadme.getAttribute("class"), /\bactive\b/);
  assert.equal(await workspaceReadme.getAttribute("aria-current"), "true");
  const editorInput = page.locator("#editor-workbench .monaco-editor .view-lines");
  await editorInput.waitFor({ timeout: 30_000 });
  await editorInput.click({ position: { x: 100, y: 12 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" EDITOR_SMOKE");
  const dirtyTab = page.locator("#editor-workbench .editor-tab.dirty");
  await dirtyTab.waitFor({ timeout: 10_000 });
  assert.match((await dirtyTab.getAttribute("aria-label")) ?? "", /unsaved/);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await dirtyTab.waitFor({ state: "hidden", timeout: 10_000 });
  const readmeTab = page.locator('.editor-tab[title="README.md"]');
  const closeReadme = page.getByRole("button", { name: "Close README.md" });
  assert.equal(await closeReadme.count(), 1);
  await closeReadme.click();
  await readmeTab.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await workspaceReadme.getAttribute("aria-current"), null);
  assert.equal(
    await page.locator("#workspace-column").getAttribute("class"),
    "workspace-column has-editor",
  );
  await page.locator("#editor-button").click();
  await page.locator("#editor-panel").waitFor({ state: "hidden" });

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "grep -q EDITOR_SMOKE README.md && echo __EDITOR_SAVE_OK__\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("__EDITOR_SAVE_OK__"),
    undefined,
    { timeout: 30_000 },
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

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "curl --version >/dev/null && echo __CURL_PRELOADED_OK__\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__CURL_PRELOADED_OK__"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "sh -c 'node -e \"console.log(\\\"__NESTED_NODE_OK__\\\", process.env.PATH)\"'\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__NESTED_NODE_OK__"),
    undefined,
    { timeout: 30_000 },
  );
  assert.match(
    await page.evaluate(() => globalThis.__wasmerShell.snapshot()),
    /__NESTED_NODE_OK__[^\n]*\/bin/,
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      `node -e 'const {execSync}=require("node:child_process"),registry=execSync("pnpm config get registry",{encoding:"utf8"}).trim();console.log("__EDGE_EXECSYNC_OK__",registry)'\r`,
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__EDGE_EXECSYNC_OK__"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      "mkdir -p .wasmer-test/bin .wasmer-test/pkg && printf '%s\\n' '#!/usr/bin/env node' 'console.log(\"__SYMLINK_SHEBANG_OK__\")' > .wasmer-test/pkg/next && ln -sf ../pkg/next .wasmer-test/bin/next && .wasmer-test/bin/next\r",
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__SYMLINK_SHEBANG_OK__"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      `node -e 'const v8=require("v8"),spaces=v8.getHeapSpaceStatistics(),stats=v8.getHeapStatistics();console.log(spaces.length>0&&stats.heap_size_limit>0?"__V8_HEAP_STATS_OK__":"__V8_HEAP_STATS_FAILED__")'\r`,
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__V8_HEAP_STATS_OK__"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(async () => {
    await globalThis.__wasmerShell.send(
      `node -e 'const fs=require("fs"),{fork}=require("child_process"),path="/workspace/.wasmer-test/fork-child.js";fs.writeFileSync(path,"process.send(\\"ready\\");process.on(\\"message\\",m=>{if(m===\\"finish\\")process.exit(0)})");const child=fork(path);child.on("message",m=>{if(m==="ready")child.send("finish")});child.on("exit",code=>console.log(code===0?"__FORK_IPC_OK__":"__FORK_IPC_FAILED__"))'\r`,
    );
  });
  await page.waitForFunction(
    () => globalThis.__wasmerShell.snapshot().includes("\n__FORK_IPC_OK__"),
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
        "(cd node-express && pnpm install --frozen-lockfile --ignore-scripts && node -e \"console.log('__PNPM_OK__', require('express/package.json').version)\")\r",
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

  if (testNextBuild) {
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send(
        "(cd next && pnpm install --frozen-lockfile --ignore-scripts && pnpm build && test -f .next/BUILD_ID && echo __NEXT_BUILD_OK__) || echo __NEXT_BUILD_FAILED__:$?\r",
      );
    });
    await page.waitForFunction(
      () => {
        const lines = globalThis.__wasmerShell
          .snapshot()
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.trim());
        return lines.includes("__NEXT_BUILD_OK__") ||
          lines.some((line) => line.startsWith("__NEXT_BUILD_FAILED__:"));
      },
      undefined,
      { timeout: nextTimeout },
    );
    const nextBuildLines = await page.evaluate(() =>
      globalThis.__wasmerShell
        .snapshot()
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim()),
    );
    assert.ok(nextBuildLines.includes("__NEXT_BUILD_OK__"));
    assert.ok(!nextBuildLines.some((line) => line.startsWith("__NEXT_BUILD_FAILED__:")));
    assert.ok(!nextBuildLines.some((line) => line.includes("Program recieved")));
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("(cd next && exec pnpm start)\r");
    });
    await page.locator("#preview-panel").waitFor({ timeout: nextTimeout });
    const nextPreview = page
      .frameLocator("#preview-panel iframe")
      .frameLocator("iframe");
    await nextPreview
      .getByText("Welcome to Next.js on Wasmer.", { exact: true })
      .waitFor({ timeout: nextTimeout });
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("\x03");
    });
    await page.waitForFunction(
      () => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").endsWith("$ "),
      undefined,
      { timeout: 30_000 },
    );
  } else if (testNext) {
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send(
        "(cd next && pnpm install --frozen-lockfile --ignore-scripts && exec pnpm dev)\r",
      );
    });
    await page.locator("#preview-panel").waitFor({ timeout: nextTimeout });
    await page.waitForFunction(
      () => {
        const transcript = globalThis.__wasmerShell
          .snapshot()
          .replace(/\x1b\[[0-9;]*m/g, "");
        return /(?:^|\n)\s*(?:✓\s*)?Ready in \d+(?:\.\d+)?(?:ms|s)\s*(?:\n|$)/.test(
          transcript,
        );
      },
      undefined,
      { timeout: nextTimeout },
    );
    const nextPreview = page
      .frameLocator("#preview-panel iframe")
      .frameLocator("iframe");
    await nextPreview
      .getByText("Welcome to Next.js on Wasmer.", { exact: true })
      .waitFor({ timeout: nextTimeout });
    await page.evaluate(async () => {
      await globalThis.__wasmerShell.send("\x03");
    });
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

  if (testPython) {
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
  }

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
  await page.locator("#live-http-badge").waitFor({ timeout: 30_000 });
  assert.equal(
    await page.locator("#live-http-label").textContent(),
    "Live HTTP :8000",
  );
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
  await page.locator("#preview-refresh").click();
  assert.match(
    (await page.locator("#preview-refresh").getAttribute("class")) ?? "",
    /\brefreshing\b/,
  );
  await preview.locator("body").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#preview-location")?.value.endsWith("/phpinfo.php"),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => !document.querySelector("#preview-refresh")?.classList.contains("refreshing"),
    undefined,
    { timeout: 10_000 },
  );
  await page.locator("#preview-back").click();
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await preview.locator("body").evaluate(() => {
    globalThis.__WASMER_SH_RELOAD_MARKER__ = true;
  });
  await preview.locator("#php-preview").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+r" : "Control+r");
  const reloadDeadline = Date.now() + 30_000;
  let shortcutReloaded = false;
  while (!shortcutReloaded && Date.now() < reloadDeadline) {
    shortcutReloaded = await preview
      .locator("body")
      .evaluate(() => globalThis.__WASMER_SH_RELOAD_MARKER__ !== true)
      .catch(() => false);
    if (!shortcutReloaded) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(shortcutReloaded, true);
  await preview.locator("#php-preview").waitFor({ timeout: 30_000 });
  await page.locator("#preview-close").click();
  await page.locator("#preview-panel").waitFor({
    state: "hidden",
    timeout: 30_000,
  });
  assert.equal(await page.locator("#live-http-badge").isVisible(), true);
  await page.locator("#live-http-badge").click();
  await page.locator("#preview-panel").waitFor({ timeout: 30_000 });
  await page
    .frameLocator("#preview-panel iframe")
    .frameLocator("iframe")
    .locator("#php-preview")
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
  await page.locator("#live-http-badge").waitFor({
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

  if (testPython) {
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
  }

  console.log("wasmer.sh browser smoke test passed");
  }
} catch (error) {
  console.error(error);
  if (page) {
    console.error(
      "shell state:",
      await page
        .evaluate(() => ({
          state: globalThis.__wasmerShell?.state(),
          transcriptTail: globalThis.__wasmerShell?.snapshot().slice(-16_000),
          status: document.querySelector("#session-status")?.textContent,
        }))
        .catch(() => undefined),
    );
    console.error(
      "editor state:",
      await page.locator("#editor-panel").innerText().catch(() => undefined),
    );
  }
  if (diagnostics.length > 0) {
    console.error(diagnostics.slice(-100).join("\n"));
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await serviceWorkerServer?.close();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
}
