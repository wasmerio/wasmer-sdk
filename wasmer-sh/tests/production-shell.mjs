import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));

test("production shell starts Bash and Python", { timeout: 180_000 }, async () => {
  let app, host, browser, page;
  const diagnostics = [];
  try {
    host = await preview({
      configFile: `${root}/service-worker/vite.config.ts`,
      logLevel: "warn",
      preview: { host: "127.0.0.1", port: 0 },
    });
    app = await preview({
      root,
      configFile: `${root}/vite.config.ts`,
      logLevel: "warn",
      preview: { host: "127.0.0.1", port: 0 },
    });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on("console", message => {
      if (message.type() === "error") diagnostics.push(message.text());
    });
    page.on("requestfailed", request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
    const browserFailure = new Promise((_, reject) => {
      page.on("pageerror", reject);
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
      console.log("Production Bash prompt ready");
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
  await page.keyboard.type(command);
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
