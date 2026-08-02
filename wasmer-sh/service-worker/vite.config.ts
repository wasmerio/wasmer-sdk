import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const crossOriginHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  root,
  cacheDir: resolve(root, "../node_modules/.vite/http"),
  server: {
    headers: crossOriginHeaders,
    fs: {
      allow: [root, fileURLToPath(new URL("../../js", import.meta.url))],
    },
  },
  preview: {
    headers: crossOriginHeaders,
  },
  build: {
    target: "es2022",
    outDir: resolve(root, "../dist-service-worker"),
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
