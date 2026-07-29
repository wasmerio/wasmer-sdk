import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

test(
  "runs Python through the browser SDK with files and live streams",
  { timeout: 180_000 },
  async () => {
    const server = await startServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const diagnostics = [];
    page.on("console", (message) =>
      diagnostics.push(`console.${message.type()}: ${message.text()}`),
    );
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.stack ?? error.message}`),
    );

    try {
      await page.goto(server.url, { waitUntil: "load" });
      const result = await page.evaluate(async () => {
        if (!globalThis.crossOriginIsolated) {
          throw new Error("browser test is not cross-origin isolated");
        }
        if (typeof SharedArrayBuffer === "undefined") {
          throw new Error("SharedArrayBuffer is unavailable");
        }

        const { Wasmer } = await import("/dist/index.js");
        const client = new Wasmer();
        let sandbox;
        try {
          sandbox = await client.sandboxes.create({
            // This package release contains CPython 3.12.0. Pin it exactly so
            // registry changes cannot silently alter the browser regression.
            packages: ["python/python@=0.2.0"],
            files: {
              "input.txt": "hello browser",
              "main.py": [
                "from pathlib import Path",
                "value = Path('/workspace/input.txt').read_text()",
                "Path('/workspace/output.txt').write_text(value.upper())",
                "print(f'python:{value}', flush=True)",
              ].join("\n"),
            },
          });

          const output = await sandbox
            .command("python", ["/workspace/main.py"])
            .run({ check: true });
          const written = await sandbox.fs.readText("output.txt");

          const process = await sandbox
            .command("python", [
              "-u",
              "-c",
              "import sys; print(sys.stdin.readline().strip().upper(), flush=True)",
            ])
            .spawn({ stdin: "pipe", stdout: "pipe", stderr: "capture" });
          if (!process.stdin || !process.stdout) {
            throw new Error("requested process pipes are unavailable");
          }
          await process.stdin.write("streamed through browser\n");
          await process.stdin.close();
          const lines = [];
          for await (const line of process.stdout.lines()) lines.push(line);
          const streamed = await process.wait({ check: true });

          return {
            crossOriginIsolated: globalThis.crossOriginIsolated,
            output: output.text(),
            written,
            lines,
            streamedReason: streamed.reason,
          };
        } finally {
          await sandbox?.close();
          await client.close();
        }
      });

      assert.deepEqual(result, {
        crossOriginIsolated: true,
        output: "python:hello browser\n",
        written: "HELLO BROWSER",
        lines: ["STREAMED THROUGH BROWSER"],
        streamedReason: "exited",
      });
    } catch (error) {
      assert.fail(`${error}\n${diagnostics.join("\n")}`);
    } finally {
      await page.close();
      await browser.close();
      await server.close();
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
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
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
