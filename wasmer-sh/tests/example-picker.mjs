import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(
  await readFile(new URL("../examples.json", import.meta.url)),
);
const proxy = http.createServer();
proxy.on("upgrade", (request, socket, head) =>
  wisp.routeRequest(request, socket, head),
);
let app, host, browser, page, monitor;
const diagnostics = [];
let commandNumber = 0;
async function command(input, timeout = 120_000) {
  const number = ++commandNumber;
  await page.evaluate(
    (input) => window.__wasmerShell.send(input),
    `${input}; printf '\\n__EXAMPLE_%s__:%s\\n' ${number} "$?"\r`,
  );
  await page.waitForFunction(
    (number) =>
      window.__wasmerShell.snapshot().includes(`__EXAMPLE_${number}__:`),
    number,
    { timeout },
  );
  const output = await page.evaluate(() => window.__wasmerShell.snapshot());
  assert(output.includes(`__EXAMPLE_${number}__:0`), output.slice(-5000));
  await waitForPrompt(output.indexOf(`__EXAMPLE_${number}__:0`));
  return output;
}
async function waitForPrompt(after) {
  await page.waitForFunction(
    (after) =>
      window.__wasmerShell
        .snapshot()
        .slice(after)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .endsWith("$ "),
    after,
  );
}
try {
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  host = await createServer({
    configFile: `${root}/service-worker/vite.config.ts`,
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0 },
  });
  await host.listen();
  process.env.VITE_WASMER_SERVICE_WORKER_ORIGIN = `http://127.0.0.1:${host.httpServer.address().port}`;
  app = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  });
  await app.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on("pageerror", (error) => diagnostics.push(error.stack));
  page.on("console", (message) => {
    // Framework demos deliberately request invalid input (400/422), and stopping
    // a server can abort preview resources. Assert their behavior below instead.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      diagnostics.push(message.text());
  });
  const url = `http://127.0.0.1:${app.httpServer.address().port}/?wisp=ws://127.0.0.1:${proxy.address().port}/`;
  const packages = [];
  page.on("request", (request) => {
    if (
      request.url().includes("registry.wasmer") ||
      request.url().includes("webcimages")
    )
      packages.push(request.url());
  });
  await page.goto(url);
  await page.locator(".example-card").last().waitFor();
  assert.equal(await page.locator(".example-card").count(), catalog.length);
  assert.equal(await page.locator("#example-picker").isVisible(), true);
  assert.equal(await page.locator(".shell-stage").isVisible(), false);
  assert.equal(await page.locator("#resume-button").isVisible(), false);
  assert.equal(
    packages.length,
    0,
    "The picker should not download any runtime packages",
  );
  if (process.env.WASMER_PICKER_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.WASMER_PICKER_SCREENSHOTS}-desktop.png`,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const ytDlp = page.locator('[data-example="yt-dlp"]');
  await ytDlp.scrollIntoViewIfNeeded();
  assert.equal(await ytDlp.isVisible(), true);
  if (process.env.WASMER_PICKER_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.WASMER_PICKER_SCREENSHOTS}-mobile.png`,
    });
  await page.setViewportSize({ width: 1440, height: 1050 });
  monitor = setInterval(async () => {
    if (page && !page.isClosed()) {
      console.log(
        "PROGRESS",
        await page
          .evaluate(() => ({
            status: document.querySelector("#session-status")?.textContent,
            output: window.__wasmerShell?.snapshot().slice(-300),
          }))
          .catch(() => "navigating"),
      );
    }
  }, 30_000);
  for (const example of catalog.filter(
    (example) =>
      !process.env.WASMER_EXAMPLE ||
      process.env.WASMER_EXAMPLE.split(",").includes(example.id),
  )) {
    console.log(`START ${example.id}`);
    await page.goto(url);
    const link = page.locator(`[data-example="${example.id}"]`);
    await link.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("#session-status").textContent === "Ready",
      undefined,
      { timeout: 180_000 },
    );
    await command(
      `test "$PWD" = /workspace/${example.source} && test -f README.md && test ! -d node_modules && test ! -d .python-packages && test ! -d /workspace/${example.id === "node" ? "python" : "node"}`,
    );
    if (example.group === "Node.js")
      await command(
        "command -v node && ! command -v python && ! command -v php && ! command -v ffmpeg",
      );
    else
      await command(
        "command -v python && ! command -v node && ! command -v php",
      );
    if (example.id === "node") {
      await command("echo KEEP_SESSION");
      await page.locator("#examples-button").click();
      await page.locator("#resume-button").click();
      await command("test -f server.js");
    }
    if (example.install) {
      console.log(`INSTALL ${example.id}`);
      await command(example.install, 300_000);
    }
    if (example.id === "yt-dlp") {
      await command(
        'qjs --version && ffmpeg -version && python -m yt_dlp --version && python -c "import yt_dlp_ejs; from yt_dlp.utils._jsruntime import QuickJsRuntime; assert QuickJsRuntime().info.supported"',
      );
      // Showing usage must not download a video; a URL is an explicit CLI argument.
      assert((await command(example.run)).includes("Video URL"));
      if (process.env.WASMER_YTDLP_TEST_URL) {
        const quotedUrl =
          "'" +
          process.env.WASMER_YTDLP_TEST_URL.replaceAll("'", "'\\''") +
          "'";
        await command(`python download.py ${quotedUrl}`, 300_000);
        await command(
          "python -c \"from pathlib import Path; files = list(Path('downloads').glob('*.mp4')); assert files and all(p.stat().st_size > 0 for p in files)\"",
        );
      }
    } else {
      await page.evaluate(
        (input) => window.__wasmerShell.send(input),
        example.run + "\r",
      );
      await page
        .locator("#preview-panel")
        .waitFor({ state: "visible", timeout: 180_000 });
      const frame = page
        .frameLocator("#preview-content iframe")
        .frameLocator("iframe");
      await frame.locator("h1").waitFor({ timeout: 180_000 });
      assert((await frame.locator("h1").innerText()).length > 0);
      if (["node", "python"].includes(example.id))
        await frame.getByText("/health is ready", { exact: true }).waitFor();
      if (example.id === "node-express")
        await frame
          .getByText("Express can reach this JSON route.", { exact: true })
          .waitFor();
      if (["python-django", "python-fastapi"].includes(example.id)) {
        await frame.locator("#checks li").nth(2).waitFor();
        assert(
          (await frame.locator("#checks li").allTextContents()).every((text) =>
            text.startsWith("PASS:"),
          ),
        );
      }
      await page.evaluate(() => window.__wasmerShell.send("\x03"));
      await page
        .locator("#preview-panel")
        .waitFor({ state: "hidden", timeout: 30_000 });
      await command("echo INPUT_RECOVERED");
    }
    console.log(`PASS ${example.id}`);
  }
  assert.deepEqual(diagnostics, []);
  console.log(
    "PASS picker, runtime isolation, selected installs, server previews, and Ctrl-C",
  );
} catch (error) {
  if (page) {
    console.error(
      await page
        .evaluate(() => window.__wasmerShell?.snapshot())
        .catch(() => ""),
    );
    await writeFile(
      "/tmp/wasmer-picker-diagnostics.json",
      JSON.stringify(diagnostics, null, 2),
    );
  }
  throw error;
} finally {
  clearInterval(monitor);
  await browser?.close();
  await app?.close();
  await host?.close();
  await new Promise((resolve) => proxy.close(resolve));
}
