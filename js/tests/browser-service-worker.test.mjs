import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { startAppServer, startHttpHost } from "./support/browser-servers.mjs";

test(
  "serves one PHP listener from the service-worker origin root",
  { timeout: 240_000 },
  async () => {
    const appHost = await startAppServer();
    const httpHost = await startHttpHost();
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
      await page.goto(appHost.url, { waitUntil: "load" });
      await page.evaluate(async (httpOrigin) => {
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
        globalThis.__wasmerTest = { wasmer, sandbox, process, httpOrigin };
        const server = await sandbox.ports.expose(8080, {
          serviceWorker: httpOrigin,
          timeoutMs: 30_000,
        });
        const iframe = server.createIframe({ title: "PHP preview" });
        iframe.id = "preview";
        document.body.append(iframe);
        globalThis.__wasmerTest.server = server;
      }, httpHost.url);

      const preview = page.frameLocator("#preview");
      await assert.doesNotReject(async () => {
        await preview.locator("#title").waitFor({ timeout: 60_000 });
        assert.equal(await preview.locator("#title").textContent(), "PHP 42");
        await preview
          .locator("#absolute")
          .filter({ hasText: "absolute route works" })
          .waitFor({ timeout: 60_000 });
      }, diagnostics.join("\n"));

      const serverState = await page.evaluate(async () => {
        const test = globalThis.__wasmerTest;
        let duplicate;
        try {
          await test.sandbox.ports.expose(8080, {
            serviceWorker: test.httpOrigin,
            timeoutMs: 5_000,
          });
        } catch (error) {
          duplicate = { message: error.message, code: error.code };
        }
        return { url: test.server.url.href, duplicate };
      });
      assert.equal(serverState.url, httpHost.url);
      assert.equal(serverState.duplicate?.code, "CAPABILITY_UNAVAILABLE");
      assert.match(serverState.duplicate?.message ?? "", /already exposes/);

      await page.evaluate(async () => {
        const test = globalThis.__wasmerTest;
        await test.server.close();
        document.querySelector("#preview")?.remove();
      });

      const hostAdmin = await browser.newPage();
      await hostAdmin.goto(new URL("/.wasmer/host.html", httpHost.url).href);
      await hostAdmin.evaluate(async () => {
        const replacement = await navigator.serviceWorker.register(
          "/.wasmer/empty-service-worker.js",
          { scope: "/" },
        );
        const worker =
          replacement.active ?? replacement.waiting ?? replacement.installing;
        if (worker && worker.state !== "activated") {
          await new Promise((resolve, reject) => {
            worker.addEventListener("statechange", () => {
              if (worker.state === "activated") resolve();
              if (worker.state === "redundant") {
                reject(new Error("replacement service worker became redundant"));
              }
            });
          });
        }
        await replacement.unregister();
      });
      await hostAdmin.close();

      await page.evaluate(async () => {
        const test = globalThis.__wasmerTest;
        const server = await test.sandbox.ports.expose(8080, {
          serviceWorker: test.httpOrigin,
          timeoutMs: 30_000,
        });
        const iframe = server.createIframe({ title: "Recovered PHP preview" });
        iframe.id = "recovered-preview";
        document.body.append(iframe);
        test.server = server;
      });
      const recoveredPreview = page.frameLocator("#recovered-preview");
      await assert.doesNotReject(async () => {
        await recoveredPreview.locator("#title").waitFor({ timeout: 60_000 });
        assert.equal(await recoveredPreview.locator("#title").textContent(), "PHP 42");
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
      await appHost.close();
      await httpHost.close();
    }
  },
);
