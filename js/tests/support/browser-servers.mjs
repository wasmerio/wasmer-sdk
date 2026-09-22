import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export async function startAppServer({ html, files = {} } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html ?? "<!doctype html><meta charset=utf-8><title>Wasmer HTTP test</title>");
        return;
      }
      if (Object.hasOwn(files, pathname)) {
        response.end(files[pathname]);
        return;
      }
      const file = resolve(packageRoot, `.${decodeURIComponent(pathname)}`);
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
    close: () => new Promise((resolvePromise, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

export async function startHttpHost() {
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      let file;
      if (pathname === "/.wasmer/host.html") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          "<!doctype html><script type=module src=/.wasmer/service-worker-host.js></script>",
        );
        return;
      }
      if (pathname === "/.wasmer/empty-service-worker.js") {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Service-Worker-Allowed", "/");
        response.end(
          "self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));" +
          "self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
        );
        return;
      }
      if (pathname === "/.wasmer/service-worker-host.js") {
        file = resolve(packageRoot, "dist/service-worker-host.js");
      } else if (pathname === "/wasmer-service-worker.js") {
        file = resolve(packageRoot, "dist/service-worker.js");
      } else {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
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
    close: () => new Promise((resolvePromise, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

function contentType(file) {
  switch (extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}
