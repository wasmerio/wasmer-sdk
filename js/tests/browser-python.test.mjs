import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ATTEMPT_TIMEOUT_MS = 120_000;
const STAGE_TIMEOUT_MS = 30_000;
const PACKAGE_LOAD_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2;

test(
  "runs Python through the browser SDK with files and live streams",
  { timeout: MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + 30_000 },
  async (context) => {
    const failures = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await runBrowserAttempt(context.signal, attempt);
        assert.deepEqual(result, {
          crossOriginIsolated: true,
          output: "python:hello browser\n",
          written: "HELLO BROWSER",
          lines: ["STREAMED THROUGH BROWSER"],
          streamedReason: "exited",
          persistentCacheHit: true,
        });
        return;
      } catch (error) {
        failures.push(`attempt ${attempt}: ${error?.stack ?? error}`);
        if (context.signal.aborted) throw error;
      }
    }

    assert.fail(failures.join("\n\n"));
  },
);

async function runBrowserAttempt(signal, attempt) {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const diagnostics = [];
  let closePromise;
  const closeBrowser = () =>
    (closePromise ??= browser.close().catch(() => undefined));
  const onAbort = () => void closeBrowser();
  signal.addEventListener("abort", onAbort, { once: true });

  page.on("console", (message) => {
    const entry = `console.${message.type()}: ${message.text()}`;
    diagnostics.push(entry);
    if (message.text().startsWith("[browser-test]")) {
      console.log(`attempt ${attempt}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) =>
    diagnostics.push(`pageerror: ${error.stack ?? error.message}`),
  );

  try {
    await page.goto(server.url, { waitUntil: "load" });
    return await withDeadline(
      page.evaluate(
        async ({ packageLoadTimeoutMs, stageTimeoutMs }) => {
          const stage = async (name, work, timeoutMs = stageTimeoutMs) => {
            const started = performance.now();
            console.log(`[browser-test] ${name}:start`);
            try {
              const value = await withBrowserDeadline(
                work(),
                timeoutMs,
                `${name} exceeded ${timeoutMs}ms`,
              );
              console.log(
                `[browser-test] ${name}:ok:${Math.round(performance.now() - started)}ms`,
              );
              return value;
            } catch (error) {
              console.error(
                `[browser-test] ${name}:error:${error?.stack ?? error}`,
              );
              throw error;
            }
          };

          if (!globalThis.crossOriginIsolated) {
            throw new Error("browser test is not cross-origin isolated");
          }
          if (typeof SharedArrayBuffer === "undefined") {
            throw new Error("SharedArrayBuffer is unavailable");
          }

          const { Wasmer } = await stage("sdk-import", () =>
            import("/dist/index.js"),
          );
          const client = new Wasmer();
          let sandbox;
          try {
            // This package release contains CPython 3.12.0. Pin it exactly so
            // registry changes cannot silently alter the browser regression.
            const python = await stage(
              "package-load",
              () => client.packages.load("python/python@=0.2.0"),
              packageLoadTimeoutMs,
            );
            sandbox = await stage("sandbox-create", () =>
              client.sandboxes.create({
                packages: [python],
                files: {
                  "input.txt": "hello browser",
                  "main.py": [
                    "from pathlib import Path",
                    "value = Path('/workspace/input.txt').read_text()",
                    "Path('/workspace/output.txt').write_text(value.upper())",
                    "print(f'python:{value}', flush=True)",
                  ].join("\n"),
                },
              }),
            );

            const output = await stage("captured-run", () =>
              sandbox
                .command("python", ["/workspace/main.py"])
                .run({ check: true }),
            );
            const written = await stage("file-read", () =>
              sandbox.fs.readText("output.txt"),
            );

            const process = await stage("streaming-spawn", () =>
              sandbox
                .command("python", [
                  "-u",
                  "-c",
                  "import sys; print(sys.stdin.readline().strip().upper(), flush=True)",
                ])
                .spawn({
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "capture",
                }),
            );
            if (!process.stdin || !process.stdout) {
              throw new Error("requested process pipes are unavailable");
            }
            await stage("stdin", async () => {
              await process.stdin.write("streamed through browser\n");
              await process.stdin.close();
            });
            const lines = await stage("stdout", async () => {
              const values = [];
              for await (const line of process.stdout.lines()) values.push(line);
              return values;
            });
            const streamed = await stage("process-wait", () =>
              process.wait({ check: true }),
            );

            const persistentCacheHit = await stage(
              "persistent-cache",
              async () => {
                const originalFetch = globalThis.fetch;
                globalThis.fetch = () =>
                  Promise.reject(
                    new Error("persistent package cache attempted network access"),
                  );
                const cachedClient = new Wasmer();
                try {
                  const cached = await cachedClient.packages.load(
                    "python/python@=0.2.0",
                  );
                  return cached.id === python.id;
                } finally {
                  await cachedClient.close();
                  globalThis.fetch = originalFetch;
                }
              },
              packageLoadTimeoutMs,
            );

            return {
              crossOriginIsolated: globalThis.crossOriginIsolated,
              output: output.text(),
              written,
              lines,
              streamedReason: streamed.reason,
              persistentCacheHit,
            };
          } finally {
            if (sandbox) {
              await stage("sandbox-close", () => sandbox.close());
            }
            await stage("client-close", () => client.close());
          }

          function withBrowserDeadline(promise, timeoutMs, message) {
            let timer;
            const deadline = new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            });
            return Promise.race([promise, deadline]).finally(() =>
              clearTimeout(timer),
            );
          }
        },
        {
          packageLoadTimeoutMs: PACKAGE_LOAD_TIMEOUT_MS,
          stageTimeoutMs: STAGE_TIMEOUT_MS,
        },
      ),
      ATTEMPT_TIMEOUT_MS,
      `browser attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
      closeBrowser,
    );
  } catch (error) {
    throw new Error(
      `${error?.stack ?? error}\n${diagnostics.join("\n")}`,
      { cause: error },
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    await closeBrowser();
    await server.close();
  }
}

async function withDeadline(promise, timeoutMs, message, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout();
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end("<!doctype html><meta charset=utf-8><title>Wasmer SDK browser test</title>");
        return;
      }

      const file = resolve(packageRoot, `.${decodeURIComponent(pathname)}`);
      if (!file.startsWith(`${packageRoot}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("Content-Type", contentType(file));
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end();
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

function contentType(file) {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}
