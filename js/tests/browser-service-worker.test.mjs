import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

test(
  "routes an iframe and its absolute URLs to a PHP listener through a service worker",
  { timeout: 240_000 },
  async () => {
    const host = await startServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const diagnostics = [];
    page.on("console", (message) =>
      diagnostics.push(`console.${message.type()}: ${message.text()}`),
    );
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.stack ?? error.message}`),
    );
    page.on("requestfailed", (request) => {
      diagnostics.push(`requestfailed: ${request.failure()?.errorText} ${request.url()}`);
    });

    try {
      await page.goto(host.url, { waitUntil: "load" });
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register(
          "/wasmer-service-worker.js",
          { scope: "/", type: "module" },
        );
        const { Wasmer } = await import("/dist/index.js");
        const wasmer = new Wasmer({
          cache: { namespace: "browser-service-worker-test" },
        });
        const sandbox = await wasmer.sandboxes.create({
          packages: ["php/php-32@=8.3.2102"],
          network: { mode: "http" },
          files: {
            "index.php": [
              "<!doctype html><title>PHP in Wasmer</title>",
              "<h1 id=title><?php echo 'PHP ' . (6 * 7); ?></h1>",
              "<div id=absolute>waiting</div>",
              "<script>fetch('/api.php').then(r => r.text()).then(t => absolute.textContent = t)</script>",
            ].join(""),
            "api.php": "<?php echo 'absolute route works'; ?>",
          },
        });
        const process = await sandbox
          .command(
            "php",
            ["-S", "0.0.0.0:8080", "-t", "/workspace"],
            { cwd: "/workspace" },
          )
          .spawn({ stdout: "pipe", stderr: "pipe" });
        if (process.stdout) {
          void (async () => {
            for await (const line of process.stdout.lines()) console.log(`php: ${line}`);
          })();
        }
        if (process.stderr) {
          void (async () => {
            for await (const line of process.stderr.lines()) console.error(`php: ${line}`);
          })();
        }
        globalThis.__wasmerTest = { wasmer, sandbox, process };
        const server = await sandbox.ports.expose(8080, {
          serviceWorker: registration,
          timeoutMs: 30_000,
        });
        const iframe = server.createIframe({ title: "PHP preview" });
        iframe.id = "preview";
        document.body.append(iframe);
        globalThis.__wasmerTest.server = server;
      });

      const preview = page.frameLocator("#preview");
      await assert.doesNotReject(async () => {
        await preview.locator("#title").waitFor({ timeout: 60_000 });
        assert.equal(await preview.locator("#title").textContent(), "PHP 42");
        await preview
          .locator("#absolute")
          .filter({ hasText: "absolute route works" })
          .waitFor({ timeout: 60_000 });
      }, diagnostics.join("\n"));

      const closedStatus = await page.evaluate(async () => {
        const test = globalThis.__wasmerTest;
        const url = test.server.url;
        await test.server.close();
        const status = (await fetch(url)).status;
        await test.process.kill();
        await test.sandbox.close();
        await test.wasmer.close();
        return status;
      });
      assert.equal(closedStatus, 404);
    } catch (error) {
      throw new Error(`${error?.stack ?? error}\n${diagnostics.join("\n")}`);
    } finally {
      await browser.close();
      await host.close();
    }
  },
);

async function startServer() {
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end("<!doctype html><meta charset=utf-8><title>Wasmer HTTP test</title>");
        return;
      }
      const relative = pathname === "/wasmer-service-worker.js"
        ? "/dist/service-worker.js"
        : pathname;
      const file = resolve(packageRoot, `.${decodeURIComponent(relative)}`);
      if (file !== packageRoot && !file.startsWith(`${packageRoot}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("Content-Type", contentType(file));
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolvePromise, reject) =>
      server.close((error) => error ? reject(error) : resolvePromise()),
    ),
  };
}

function contentType(file) {
  switch (extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}
