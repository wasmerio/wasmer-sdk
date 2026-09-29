import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));

test("production shell starts Bash, Python and Pi with an older SDK cached", { timeout: 180_000 }, async () => {
  let app, host, browser, page;
  const diagnostics = [];
  // Old releases used this stable URL even when its exports changed. Seed the
  // real HTTP cache, not Playwright routing (which disables browser caching).
  const legacySnippet = "/assets/snippets/wasmer-napi-4dc421676e010b84/inline0.js";
  const oldSource = "export const oldSdk = true;";
  let legacyRequests = 0;
  const cachedRuntimeFixture = {
    name: "cached-runtime-fixture",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === "/__prime-cache") {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><title>Prime the previous SDK cache</title>");
        } else if (request.url === legacySnippet) {
          legacyRequests++;
          response.setHeader("Content-Type", "text/javascript");
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          response.end(oldSource);
        } else next();
      });
    },
  };
  try {
    host = await preview({
      configFile: `${root}/service-worker/vite.config.ts`,
      logLevel: "warn",
      preview: { host: "127.0.0.1", port: 0 },
    });
    app = await preview({
      root,
      plugins: [cachedRuntimeFixture],
      build: { outDir: process.env.WASMER_PRODUCTION_DIR ?? "dist" },
      configFile: `${root}/vite.config.ts`,
      logLevel: "warn",
      preview: { host: "127.0.0.1", port: 0 },
    });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
    await page.goto(`${origin}/__prime-cache`);
    for (let i = 0; i < 2; i++) {
      assert.equal(await page.evaluate(async path => (await fetch(path)).text(), legacySnippet), oldSource);
    }
    assert.equal(legacyRequests, 1, "The old SDK snippet must be in the browser HTTP cache");
    const runtimeRequests = [];
    page.on("request", request => runtimeRequests.push(new URL(request.url()).pathname));
    page.on("console", message => {
      if (message.type() === "error") diagnostics.push(message.text());
    });
    page.on("requestfailed", request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
    const browserFailure = new Promise((_, reject) => {
      page.on("pageerror", reject);
      page.on("console", message => {
        if (message.type() === "error" && message.text().includes("SDK worker failed")) {
          reject(new Error(message.text()));
        }
      });
      page.on("response", response => {
        if (response.url().includes("/assets/") && response.status() >= 400) {
          reject(new Error(`Runtime asset failed: ${response.status()} ${response.url()}`));
        }
      });
    });
    const exercise = async () => {
      const url = new URL(`http://127.0.0.1:${app.httpServer.address().port}/`);
      url.searchParams.set("example", "python");
      url.searchParams.set("httpOrigin", `http://127.0.0.1:${host.httpServer.address().port}/`);
      await page.goto(url.href);
      // The welcome banner and "Ready" label precede any output from Bash.
      // Require the actual rendered prompt, without the development-only API.
      await waitForPrompt(page);
      assert(!runtimeRequests.includes(legacySnippet), "Runtime must not reuse the old SDK snippet URL");
      assert(runtimeRequests.some(path => /\/wasmer-runtime-[a-f0-9]+\/.*inline0\.js$/.test(path)),
        "Worker must load the content-addressed SDK snippet");
      console.log("Production Bash prompt ready with the old SDK cached");
      await send(page, "printf '__SHELL_%s__\\n' READY");
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".xterm-rows > div")].some(row => row.textContent.trim() === "__SHELL_READY__"),
      );
      console.log("Production shell command completed");
      await send(page, "python server.py");
      const serverPage = page.frameLocator("#preview-panel iframe").frameLocator("iframe");
      await serverPage.locator("#python-preview").waitFor({ timeout: 30_000 });
      await serverPage.locator("#python-health").filter({ hasText: "/health is ready" }).waitFor({ timeout: 30_000 });
      console.log("Production Python HTTP ready");
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+c");
      await page.locator("#preview-panel").waitFor({ state: "hidden", timeout: 30_000 });
      await waitForPrompt(page);
      console.log("Bash prompt, command output, Python HTTP and Ctrl-C passed");
      url.searchParams.set("example", "pi");
      await page.goto(url.href);
      await waitForPrompt(page);
      // Avoid Pi's update check opening the outbound-network setup dialog.
      await send(page, "pi --offline");
      await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("pi v0.87.1"),
        undefined, { timeout: 60_000 });
      console.log("Production Pi UI ready");
      await send(page, "/login");
      await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("Select authentication method:"));
      console.log("Production Pi login menu accepted keyboard input");
      await page.keyboard.press("Control+c");
      await page.waitForFunction(() => !document.querySelector("#terminal").textContent.includes("Select authentication method:"));
      await send(page, "/quit");
      await waitForPrompt(page);
      console.log("Production Pi interactive launch, keyboard input and exit passed");
    };
    await Promise.race([exercise(), browserFailure]);
  } catch (error) {
    console.error("Shell status:", await page?.locator("#session-status").textContent().catch(() => "Unavailable"));
    console.error(await page?.locator("#terminal").innerText().catch(() => "No terminal"));
    console.error(diagnostics.join("\n"));
    throw error;
  } finally {
    await browser?.close();
    for (const server of [app, host]) {
      if (!server) continue;
      server.httpServer.closeAllConnections();
      await new Promise(resolve => server.httpServer.close(resolve));
    }
  }
});

async function send(page, command) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command, { delay: 50 });
  await page.keyboard.press("Enter");
}

async function waitForPrompt(page) {
  await page.waitForFunction(() => {
    if (document.documentElement.dataset.state === "error") {
      throw new Error(document.querySelector("#terminal").textContent);
    }
    const lines = [...document.querySelectorAll(".xterm-rows > div")]
      .map(row => row.textContent.trim()).filter(Boolean);
    return /^➜\s+~\s+\$$/.test(lines.at(-1) ?? "");
  }, undefined, { timeout: 90_000 });
}
