import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const crossOriginHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
const controlDocuments = new Map([
  ["/.wasmer/browser.html", resolve(root, ".wasmer/browser.html")],
  ["/.wasmer/host.html", resolve(root, ".wasmer/host.html")],
]);

export default defineConfig({
  root,
  cacheDir: resolve(root, "node_modules/.vite"),
  plugins: [
    {
      name: "wasmer-static-control-documents",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          const file = controlDocuments.get(pathname);
          if (!file) {
            next();
            return;
          }
          try {
            for (const [name, value] of Object.entries(crossOriginHeaders)) {
              response.setHeader(name, value);
            }
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(await readFile(file));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
  server: {
    headers: crossOriginHeaders,
    fs: {
      allow: [root],
    },
  },
  preview: {
    headers: crossOriginHeaders,
  },
  build: {
    target: "es2022",
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        browser: resolve(root, ".wasmer/browser.html"),
        host: resolve(root, ".wasmer/host.html"),
        "wasmer-service-worker": resolve(root, "wasmer-service-worker.js"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "wasmer-service-worker"
            ? "wasmer-service-worker.js"
            : ".wasmer/[name]-[hash].js",
      },
    },
  },
});
