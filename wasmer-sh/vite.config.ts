import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const root = fileURLToPath(new URL(".", import.meta.url));
const edgejsWebcUrl = process.env.VITE_EDGEJS_WEBC_URL;
const edgejsWebcPath = edgejsWebcUrl?.startsWith("/@fs/")
  ? decodeURIComponent(edgejsWebcUrl.slice("/@fs".length))
  : undefined;

export default defineConfig({
  cacheDir: resolve(root, "node_modules/.vite/app"),
  server: {
    headers: crossOriginIsolationHeaders,
    fs: {
      // The repository uses the local SDK package through `link:../js`.
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../js", import.meta.url)),
        fileURLToPath(new URL("../fixtures", import.meta.url)),
        ...(edgejsWebcPath ? [dirname(edgejsWebcPath)] : []),
      ],
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    // Keep the SDK's worker and wasm-bindgen module URLs intact in development.
    exclude: ["@wasmer/sdk2"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
