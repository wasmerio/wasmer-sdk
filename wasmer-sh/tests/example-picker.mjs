import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(
  await readFile(new URL("../examples.json", import.meta.url)),
);
const selectedExamples = catalog.filter(
  (example) => !process.env.WASMER_EXAMPLE || process.env.WASMER_EXAMPLE.split(",").includes(example.id),
);
let proxyConnections = 0;
let proxy, app, host, browser, page, monitor;
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
  // Bash writes its prompt to stderr, which can arrive before stdout. The
  // stdout completion marker is enough to submit the next command safely.
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
  // PostgreSQL needs only virtual localhost. Other examples install packages
  // through Wisp; do not start that proxy for the standalone PostgreSQL check.
  if (selectedExamples.some(example => example.id !== "postgres")) {
    const { server: wisp } = await import("@mercuryworkshop/wisp-js/server");
    proxy = http.createServer();
    proxy.on("upgrade", (request, socket, head) => {
      proxyConnections++;
      wisp.routeRequest(request, socket, head);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  }
  process.env.VITE_WISP_URL = "";
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
  const browserType = { chromium, firefox, webkit }[process.env.WASMER_BROWSER ?? "chromium"];
  assert(browserType, "WASMER_BROWSER must be chromium, firefox, or webkit");
  browser = await browserType.launch({ headless: true });
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
  const url = `http://127.0.0.1:${app.httpServer.address().port}/`;
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
    "node-richards/richards.js", "clang/hello.c", "postgres/demo.sql",
  ])
    assert(fullShellPaths.includes(path), `Missing full-shell source: ${path}`);
  assert.equal(
    packages.length,
    0,
    "The picker should not download any runtime packages",
  );
  const environments = await page.evaluate(async () => {
    const { examples, exampleEnvironment } = await import("/src/examples.ts");
    return {
      shell: exampleEnvironment(),
      clang: exampleEnvironment(examples.find(example => example.id === "clang")),
      node: exampleEnvironment(examples.find(example => example.id === "node")),
    };
  });
  assert.equal(environments.shell.CCC_OVERRIDE_OPTIONS, "#^-resource-dir=/lib/clang/16");
  assert.equal(environments.clang.CCC_OVERRIDE_OPTIONS, environments.shell.CCC_OVERRIDE_OPTIONS);
  assert.equal(environments.node.CCC_OVERRIDE_OPTIONS, undefined);
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
  for (const id of ["postgres", "clang", "ffmpeg", "yt-dlp"]) {
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
  for (const example of selectedExamples) {
    console.log(`START ${example.id}`);
    const connections = proxyConnections;
    const exampleUrl = new URL(url);
    if (example.id === "postgres") {
      await page.evaluate(() => localStorage.removeItem("wasmer.sh:wisp-url"));
    } else {
      exampleUrl.searchParams.set("wisp", `ws://127.0.0.1:${proxy.address().port}/`);
    }
    await page.goto(exampleUrl.href);
    const link = page.locator(`[data-example="${example.id}"]`);
    await link.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("#session-status").textContent === "Ready",
      undefined,
      { timeout: 180_000 },
    );
    await waitForPrompt(0);
    await command(
      `test "$PWD" = /workspace && test -f README.md && test ! -d node_modules && test ! -d .python-packages && test ! -d /workspace/${example.source} && test ! -e .picker-example && test "$PIP_TARGET" = /workspace/.python-packages && test "$PYTHONPATH" = /workspace/.python-packages`,
    );
    await command(`printf '%s' '${example.id}' > .picker-example`);
    if (example.group === "Node.js")
      await command(
        "command -v node && ! command -v python && ! command -v php && ! command -v ffmpeg",
      );
    else if (example.id === "postgres")
      await command("command -v pglite && command -v psql && ! command -v node && ! command -v python && ! command -v ffmpeg");
    else if (example.id === "clang")
      await command(
        "command -v clang && ! command -v node && ! command -v python && ! command -v ffmpeg",
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
      await command("export PICKER_SESSION=kept; echo KEEP_SESSION");
      const terminalUrl = page.url();
      const homepage = new URL(terminalUrl);
      homepage.searchParams.delete("example");
      await page.locator("#examples-button").click();
      assert.equal(page.url(), homepage.href);
      assert.equal(await page.locator("#example-picker").isVisible(), true);
      assert.equal(await page.locator(".shell-stage").isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), "examples-title");
      assert.equal(await page.locator("#resume-button").getAttribute("href"), terminalUrl);
      await page.goBack();
      assert.equal(page.url(), terminalUrl);
      assert.equal(await page.locator(".shell-stage").isVisible(), true);
      await command('test "$PICKER_SESSION" = kept && test -f .picker-example');
      await page.goForward();
      assert.equal(page.url(), homepage.href);
      assert.equal(await page.locator("#example-picker").isVisible(), true);
      await page.locator("#resume-button").click();
      assert.equal(page.url(), terminalUrl);
      await command('test "$PICKER_SESSION" = kept && test -f server.js');
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
    } else if (example.id === "postgres") {
      assert.equal(new URL(page.url()).searchParams.has("wisp"), false);
      assert.equal(await page.locator("#wisp-dialog").isVisible(), false);
      const batch = await command("psql -At -v ON_ERROR_STOP=1 -f demo.sql");
      assert(batch.includes("Hello from PostgreSQL in Wasmer!"));
      assert(batch.includes("PostgreSQL 18.4"));
      await page.evaluate(() => window.__wasmerShell.waitForPort(5432));
      await page.evaluate(() => window.__wasmerShell.send("psql -At\r"));
      await page.waitForFunction(() => window.__wasmerShell.snapshot().includes("postgres=#"));
      assert.equal(await page.locator("#preview-panel").isVisible(), false);
      await page.evaluate(() => window.__wasmerShell.send("SELECT 1 / 0;\rSELECT 'PG_' || 'RECOVERED';\r"));
      await page.waitForFunction(() => window.__wasmerShell.snapshot().includes("PG_RECOVERED"));
      const beforeQuit = await page.evaluate(() => window.__wasmerShell.snapshot().length);
      await page.evaluate(() => window.__wasmerShell.send("\\q\r"));
      await waitForPrompt(beforeQuit);
      await page.evaluate(() => window.__wasmerShell.waitForPort(5432));
      assert((await command("psql -Atc 'SELECT count(*) AS saved_notes FROM notes'")).includes("\n1\n"));
      // A server with no client reaches WASIX's accept timeout after 30 seconds.
      await new Promise(resolve => setTimeout(resolve, 32_000));
      await page.evaluate(() => window.__wasmerShell.waitForPort(5432));
      assert((await command("psql -Atc 'SELECT count(*) FROM notes'")).includes("\n1\n"));
      assert.equal(await page.locator("#preview-panel").isVisible(), false);
      assert.equal(proxyConnections, connections, "PostgreSQL must not connect to Wisp");
      assert.equal(await page.locator("#wisp-dialog").isVisible(), false);
    } else if (example.id === "node-richards") {
      const output = await command(example.run);
      assert(output.includes("1000 iterations/sample; 5 samples;"));
      assert(output.includes("Sample 5/5:"));
      assert(/Median: [\d.]+ ms \([\d.]+ ms\/iteration\)/.test(output));
      assert(output.includes("PASS: every iteration checked queueCount=2322, holdCount=928."));
      console.log(output.slice(output.lastIndexOf("Richards.js —")));
      const repeated = await command("node richards.js 2000 2");
      assert(repeated.includes("2000 iterations/sample; 2 samples;"));
      assert(repeated.includes("Sample 2/2:"));
      await command("node richards.js 0; test \"$?\" = 1");
      assert.equal(await page.locator("#preview-panel").isVisible(), false);
    } else if (example.id === "clang") {
      await command('test "$(clang -print-resource-dir)" = /lib/clang/16 && test "$(clang -resource-dir=/override -print-resource-dir)" = /override');
      const output = await command(example.run, 180_000);
      assert(output.includes("Hello, Wasmer!"));
      assert(output.includes("This C program was compiled to WebAssembly and run locally."));
      assert((await command('./hello.wasm "C developer"')).includes("Hello, C developer!"));
      const rebuilt = await command(
        'printf \'#include <stdio.h>\\nint main(void) { puts("Rebuilt C program"); return 0; }\\n\' > rebuilt.c && clang rebuilt.c -o hello.wasm && ./hello.wasm',
        180_000,
      );
      assert(rebuilt.includes("Rebuilt C program"));
      await command("printf 'invalid C source' > broken.c; ! clang broken.c -o broken.wasm", 180_000);
      assert.equal(await page.locator("#preview-panel").isVisible(), false);

      // Also exercise the documented public SDK path without Bash: compile,
      // read the emitted bytes, install the module, and run its entrypoint.
      const sdkOutput = await page.evaluate(async ({ sdkUrl, env }) => {
        const { Wasmer } = await import(sdkUrl);
        const client = new Wasmer();
        let sandbox;
        try {
          sandbox = await client.sandboxes.create({
            packages: ["clang/clang@=0.160000.1"],
            env,
            files: { "hello.c": '#include <stdio.h>\nint main(void) { puts("Hello from the JS SDK!"); return 0; }\n' },
          });
          await sandbox.command("clang", ["hello.c", "-o", "hello.wasm"]).run();
          const bytes = await sandbox.fs.readFile("hello.wasm");
          const program = await sandbox.installPackage(bytes);
          return (await sandbox.command(program).run()).text();
        } finally {
          await sandbox?.close();
          await client.close();
        }
      }, { sdkUrl: "/@fs" + fileURLToPath(import.meta.resolve("@wasmer/sdk/browser")), env: example.env });
      assert.equal(sdkOutput, "Hello from the JS SDK!\n");
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
    if (example.id === "node") {
      await page.locator("#examples-button").click();
      const requestsBeforeReload = packages.length;
      await page.reload();
      await page.locator(".example-card").last().waitFor();
      assert.equal(new URL(page.url()).searchParams.has("example"), false);
      assert.equal(await page.locator("#example-picker").isVisible(), true);
      assert.equal(await page.locator("#resume-button").isVisible(), false);
      assert.equal(packages.length, requestsBeforeReload, "Reloading the homepage must not start a runtime");
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
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
}
