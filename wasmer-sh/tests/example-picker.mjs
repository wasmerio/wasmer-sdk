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
  const fullShellPaths = await page.evaluate(async () => {
    const { exampleFiles } = await import("/src/examples.ts");
    return Object.keys(exampleFiles());
  });
  for (const path of [
    "node/server.js", "python/server.py", "python-django/manage.py",
    "python-django/mysite/settings.py", "next/pages/index.js", "yt-dlp/yt-dlp.conf",
  ])
    assert(fullShellPaths.includes(path), `Missing full-shell source: ${path}`);
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
  for (const id of ["ffmpeg", "yt-dlp"]) {
    const tool = page.locator(`[data-example="${id}"]`);
    await tool.scrollIntoViewIfNeeded();
    assert.equal(await tool.isVisible(), true);
    await tool.locator("img").evaluate((icon) => icon.decode());
  }
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
      `test "$PWD" = /workspace && test -f README.md && test ! -d node_modules && test ! -d .python-packages && test ! -d /workspace/${example.source} && test ! -e .picker-example && test "$PIP_TARGET" = /workspace/.python-packages && test "$PYTHONPATH" = /workspace/.python-packages`,
    );
    await command(`printf '%s' '${example.id}' > .picker-example`);
    if (example.group === "Node.js")
      await command(
        "command -v node && ! command -v python && ! command -v php && ! command -v ffmpeg",
      );
    else if (example.id === "ffmpeg")
      await command(
        "command -v ffmpeg && command -v ffprobe && ! command -v python && ! command -v node && ! command -v php",
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
    if (example.id === "python-django") {
      await command(
        "test -f manage.py && test -f mysite/urls.py && test ! -f server.py && python manage.py check && python manage.py migrate --noinput && python manage.py migrate --check",
        180_000,
      );
    }
    if (example.id === "yt-dlp") {
      await command(
        'qjs --version && ffmpeg -version && /workspace/.python-packages/bin/yt-dlp --version && python -c "import yt_dlp_ejs; from yt_dlp.utils._jsruntime import QuickJsRuntime; assert QuickJsRuntime().info.supported"',
      );
      // Showing usage must not download a video; a URL is an explicit CLI argument.
      assert((await command(example.run)).includes("Usage: yt-dlp [OPTIONS] URL"));
      if (process.env.WASMER_YTDLP_TEST_URL) {
        const quotedUrl =
          "'" +
          process.env.WASMER_YTDLP_TEST_URL.replaceAll("'", "'\\''") +
          "'";
        await command(
          `/workspace/.python-packages/bin/yt-dlp ${quotedUrl}`,
          300_000,
        );
        await command(
          "python -c \"from pathlib import Path; files = list(Path('downloads').glob('*.mp4')); assert files and all(p.stat().st_size > 0 for p in files)\"",
        );
      }
    } else if (example.id === "ffmpeg") {
      await command(example.run, 180_000);
      const metadata = await command(
        "test -s /workspace/wordpress.gif && ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,nb_read_frames:format=format_name,duration -of json /workspace/wordpress.gif",
      );
      assert(metadata.includes('"format_name": "gif"'));
      assert(metadata.includes('"codec_name": "gif"'));
      assert(metadata.includes('"width": 320'));
      assert(metadata.includes('"height": 180'));
      const frames = metadata.match(/"nb_read_frames": "(\d+)"/);
      assert(frames && Number(frames[1]) > 1, "Expected an animated GIF");
      assert.equal(await page.locator("#preview-panel").isVisible(), false);
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
      if (example.id === "python-django") {
        assert.equal(
          await frame.locator("h1").innerText(),
          "The install worked successfully! Congratulations!",
        );
        const admin = await frame.locator("body").evaluate(async () => {
          const login = await fetch("/admin/login/?next=/admin/");
          const html = await login.text();
          const css = await fetch("/static/admin/css/base.css");
          return {
            status: login.status,
            hasLogin: html.includes('name="username"') && html.includes('name="csrfmiddlewaretoken"'),
            cssStatus: css.status,
            css: await css.text(),
          };
        });
        assert.equal(admin.status, 200);
        assert.equal(admin.hasLogin, true);
        assert.equal(admin.cssStatus, 200);
        assert(admin.css.includes("body"));
      }
      if (example.id === "python-fastapi") {
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
    "PASS picker and selected examples: runtime isolation, installs, tools, conversions, server previews, and Ctrl-C",
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
