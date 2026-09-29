import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const root = fileURLToPath(new URL(".", import.meta.url));
const sdkDist = dirname(
  fileURLToPath(import.meta.resolve("@wasmer/sdk/browser")),
);
const edgejsWebcUrl = process.env.VITE_EDGEJS_WEBC_URL;
const edgejsWebcPath = edgejsWebcUrl?.startsWith("/@fs/")
  ? decodeURIComponent(edgejsWebcUrl.slice("/@fs".length))
  : undefined;

// URL-loaded SDK entrypoints are not traversed by Vite. Keep their complete
// dependency graph under one content-addressed directory so a browser cannot
// combine a new worker with support modules cached from an earlier release.
function sdkRuntimeAssets(): Plugin {
  const sdkRoot = resolve(sdkDist, "..");
  const workerPath = resolve(sdkDist, "browser-worker.js");
  const bindingPath = resolve(sdkRoot, "pkg/wasmer_sdk_js.js");
  const wasmPath = resolve(sdkRoot, "pkg/wasmer_sdk_js_bg.wasm");
  const references = new Map<string, string>();
  return {
    name: "wasmer-sdk-runtime-assets",
    apply: "build",
    enforce: "pre",
    async buildStart() {
      const files = new Map<string, Buffer>();
      const collectModule = async (file: string): Promise<void> => {
        if (files.has(file)) return;
        const source = await readFile(file);
        files.set(file, source);
        this.addWatchFile(file);
        for (const statement of this.parse(source.toString()).body) {
          if (
            (statement.type === "ImportDeclaration" ||
              statement.type === "ExportNamedDeclaration" ||
              statement.type === "ExportAllDeclaration") &&
            typeof statement.source?.value === "string" &&
            statement.source.value.startsWith(".")
          ) {
            await collectModule(resolve(dirname(file), statement.source.value));
          }
        }
      };
      const collectDirectory = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = resolve(directory, entry.name);
          if (entry.isDirectory()) await collectDirectory(file);
          else {
            files.set(file, await readFile(file));
            this.addWatchFile(file);
          }
        }
      };
      await collectModule(workerPath);
      await collectModule(bindingPath);
      // Include snippet licenses and other package-owned companion files.
      await collectDirectory(resolve(sdkRoot, "pkg/snippets"));
      files.set(wasmPath, await readFile(wasmPath));
      this.addWatchFile(wasmPath);
      const entries = [...files].map(([file, source]) => ({
        file, source, path: relative(sdkRoot, file).split(sep).join("/"),
      })).sort((a, b) => a.path.localeCompare(b.path));
      const hash = createHash("sha256");
      for (const { path, source } of entries) {
        hash.update(path).update("\0").update(source).update("\0");
      }
      const directory = `assets/wasmer-runtime-${hash.digest("hex").slice(0, 16)}`;
      references.clear();
      for (const { file, path, source } of entries) {
        references.set(file, this.emitFile({
          type: "asset", fileName: `${directory}/${path}`, source,
        }));
      }
    },
    transform(source, id) {
      // Replace URL expressions before Vite copies the raw entrypoint. Rollup
      // resolves these references with the configured deployment base URL.
      const urls = id === resolve(sdkDist, "index.js")
        ? [["../pkg/wasmer_sdk_js.js", bindingPath], ["./browser-worker.js", workerPath]]
        : id === bindingPath ? [["wasmer_sdk_js_bg.wasm", wasmPath]] : [];
      if (urls.length === 0) return;
      for (const [url, file] of urls) {
        const single = `new URL('${url}', import.meta.url)`;
        const double = `new URL("${url}", import.meta.url)`;
        if (!source.includes(single) && !source.includes(double)) {
          this.error(`SDK runtime URL not found in ${id}: ${url}`);
        }
        const replacement = `new URL(import.meta.ROLLUP_FILE_URL_${references.get(file)}, import.meta.url)`;
        source = source.replaceAll(single, replacement).replaceAll(double, replacement);
      }
      return { code: source, map: null };
    },
  };
}

export default defineConfig({
  plugins: [sdkRuntimeAssets()],
  cacheDir: resolve(root, "node_modules/.vite/app"),
  server: {
    headers: crossOriginIsolationHeaders,
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../fixtures", import.meta.url)),
        // A linked SDK keeps its worker and wasm assets outside this app.
        resolve(sdkDist, ".."),
        ...(edgejsWebcPath ? [dirname(edgejsWebcPath)] : []),
      ],
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    // Keep the SDK's worker and wasm-bindgen module URLs intact in development.
    exclude: ["@wasmer/sdk"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
