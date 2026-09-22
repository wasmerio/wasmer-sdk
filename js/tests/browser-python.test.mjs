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

test("browser workers report rejected initialization, tasks, and unhandled promises", { timeout: 20_000 }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    for (const failure of ["initialization", "queued task", "unhandled promise"]) {
      const message = await page.evaluate(async failure => {
        const source = `
          export default async function () {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (${JSON.stringify(failure)} === 'initialization') throw new Error('injected initialization');
          }
          export class ThreadPoolWorker {
            constructor() {
              if (${JSON.stringify(failure)} === 'unhandled promise') Promise.reject(new Error('injected unhandled promise'));
            }
            async handle() { throw new Error('injected queued task'); }
          }
        `;
        const worker = new Worker('/dist/browser-worker.js', { type: 'module' });
        let timer;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('worker failure never reached its parent')), 3000);
            worker.onerror = event => { event.preventDefault(); resolve(event.message); };
            worker.postMessage({ type: 'init', id: 1, sdkUrl: 'data:text/javascript,' + encodeURIComponent(source) });
            if (failure === 'queued task') worker.postMessage({ run: true });
          });
        } finally {
          clearTimeout(timer);
          worker.terminate();
        }
      }, failure);
      assert.match(message, new RegExp(`injected ${failure}`));
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("missing worker modules fail processes and shutdown instead of hanging", { timeout: 90_000 }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const workerPath of ["/missing-worker.js", "/broken-import-worker.js"]) {
      const page = await browser.newPage();
      await page.route("**/broken-import-worker.js", route => route.fulfill({
        contentType: "text/javascript",
        body: "import './missing-dependency.js';",
      }));
      await page.goto(server.url);
      let timer;
      try {
        const result = await Promise.race([
          page.evaluate(async workerPath => {
            const { Wasmer } = await import("/dist/index.js");
            const { setWorkerUrl } = await import("/pkg/wasmer_sdk_js.js");
            const client = new Wasmer({ cache: false });
            const pkg = await client.packages.load("wasmer/hello-world@0.2.5");
            const sandbox = await client.sandboxes.create({ packages: [pkg] });
            setWorkerUrl(new URL(workerPath, location.href).href);
            const process = await sandbox.command("hello").spawn();
            const closed = client.close().then(
              () => ({ code: "unexpected success", message: "" }),
              error => ({ code: error.code, message: error.message }),
            );
            const output = await process.wait();
            const failure = await closed;
            await sandbox.close();
            return { exitCode: output.exitCode, failure };
          }, workerPath),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Worker failure was not propagated: ${workerPath}`)), 40_000);
          }),
        ]);
        assert.equal(result.exitCode, 1);
        assert.equal(result.failure.code, "WORKER_FAILED");
        assert.match(result.failure.message, /Unable to load worker module/);
        assert.ok(result.failure.message.includes(workerPath));
      } finally {
        clearTimeout(timer);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test(
  "runs Python browser workers with threads, late modules, files and streams",
  { timeout: MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + 30_000 },
  async (context) => {
    const failures = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await runBrowserAttempt(context.signal, attempt);
        assert.deepEqual(result, {
          crossOriginIsolated: true,
          output: "python:hello browser\n",
          threaded: "thread:ok\nchild-thread:ok\nrich:ok\n",
          lateModule: "late-dlopen:ok\n",
          repeatedThreads: "repeated-threads:ok\n",
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
            // Pin the package exactly so registry changes cannot silently alter
            // the browser regression.
            const python = await stage(
              "package-load",
              () => client.packages.load("python/python@=3.13.20"),
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
                .run(),
            );
            const threaded = await stage(
              "python-threading",
              () =>
                sandbox
                  .command("python", [
                    "-u",
                    "-c",
                    [
                      "import threading",
                      "import zlib, _hashlib",
                      "result = []",
                      "thread = threading.Thread(target=lambda: result.append((zlib.decompress(zlib.compress(b'ok')).decode(), _hashlib.openssl_sha256(b'abc').hexdigest())))",
                      "thread.start()",
                      "thread.join()",
                      "assert result == [('ok', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')], result",
                      "print(f'thread:{result[0][0]}', flush=True)",
                      "import subprocess, sys",
                      "subprocess.run([sys.executable, '-c', \"import threading; result=[]; t=threading.Thread(target=lambda: result.append('ok')); t.start(); t.join(); assert result == ['ok']; print('child-thread:ok')\"], check=True)",
                      "import io",
                      "from pip._vendor.rich.console import Console",
                      "from pip._vendor.rich.progress import Progress",
                      "progress = Progress(console=Console(file=io.StringIO()))",
                      "progress.start()",
                      "progress.stop()",
                      "print('rich:ok', flush=True)",
                    ].join("; "),
                  ])
                  .run(),
              15_000,
            );
            const lateModule = await stage("python-late-dlopen", () =>
              sandbox
                .command("python", [
                  "-u",
                  "-c",
                  [
                    "import threading, sys",
                    "ready = threading.Event()",
                    "go = threading.Event()",
                    "result = []",
                    "def child():",
                    "    ready.set()",
                    "    assert go.wait(15)",
                    "    import zlib, _hashlib, _bz2, _lzma",
                    "    result.append(zlib.decompress(zlib.compress(b'late')))",
                    "    result.append(_hashlib.openssl_sha256(b'abc').hexdigest())",
                    "    result.append(_bz2.BZ2Compressor().compress(b'hello'))",
                    "    result.append(_lzma.LZMACompressor().compress(b'hello') is not None)",
                    "t = threading.Thread(target=child)",
                    "t.start()",
                    "assert ready.wait(15)",
                    "assert 'zlib' not in sys.modules",
                    "import zlib, _hashlib, _bz2, _lzma",
                    "go.set()",
                    "t.join(15)",
                    "assert not t.is_alive()",
                    "assert result[0] == b'late', result",
                    "assert result[1] == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', result",
                    "assert result[3] is True, result",
                    "print('late-dlopen:ok', flush=True)",
                  ].join("\n"),
                ])
                .run(),
            );
            const repeatedThreads = await stage("repeated-progress-threads", () =>
              sandbox.command("python", ["-u", "-c", [
                "import io, threading, time, zlib",
                "from pip._vendor.rich.console import Console",
                "from pip._vendor.rich.progress import Progress",
                "for iteration in range(20):",
                "    progress = Progress(console=Console(file=io.StringIO(), force_terminal=True))",
                "    progress.start()",
                "    task = progress.add_task('install', total=3)",
                "    results = []",
                "    threads = [threading.Thread(target=lambda: results.append(zlib.decompress(zlib.compress(b'ok')))) for _ in range(3)]",
                "    for thread in threads: thread.start()",
                "    for thread in threads: thread.join()",
                "    assert results == [b'ok'] * 3, results",
                "    progress.update(task, advance=3)",
                "    time.sleep(0.01)",
                "    progress.stop()",
                "print('repeated-threads:ok', flush=True)",
              ].join("\n")]).run(),
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
                    "python/python@=3.13.20",
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
              threaded: threaded.text(),
              lateModule: lateModule.text(),
              repeatedThreads: repeatedThreads.text(),
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
