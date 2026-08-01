import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  optimizeDeps: { exclude: ["@wasmer/sdk2"] },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        app: resolve(root, "index.html"),
        "wasmer-service-worker": resolve(root, "wasmer-service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "wasmer-service-worker"
            ? "wasmer-service-worker.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
});
