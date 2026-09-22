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

// The SDK loads its worker and wasm-bindgen module by URL. Vite copies those
// entrypoints as assets without traversing their ESM imports, so emit their
// package-owned companion modules at the relative paths the entrypoints use.
function sdkRuntimeAssets(): Plugin {
  return {
    name: "wasmer-sdk-runtime-assets",
    async generateBundle() {
      // Follow the installed worker's imports instead of maintaining a list
      // that can miss new SDK modules. Vite emits the worker itself by URL.
      const visited = new Set<string>();
      const emitWorkerImports = async (file: string, emit = true): Promise<void> => {
        if (visited.has(file)) return;
        visited.add(file);
        const source = await readFile(file, "utf8");
        if (emit) {
          this.emitFile({
            type: "asset",
            fileName: `assets/${relative(sdkDist, file).split(sep).join("/")}`,
            source,
          });
        }
        for (const statement of this.parse(source).body) {
          if (
            (statement.type === "ImportDeclaration" ||
              statement.type === "ExportNamedDeclaration" ||
              statement.type === "ExportAllDeclaration") &&
            typeof statement.source?.value === "string" &&
            statement.source.value.startsWith(".")
          ) {
            await emitWorkerImports(resolve(dirname(file), statement.source.value));
          }
        }
      };
      const emitDirectory = async (
        sourceDirectory: string,
        outputDirectory: string,
      ): Promise<void> => {
        for (const entry of await readdir(sourceDirectory, {
          withFileTypes: true,
        })) {
          const sourcePath = resolve(sourceDirectory, entry.name);
          const outputPath = `${outputDirectory}/${entry.name}`;
          if (entry.isDirectory()) {
            await emitDirectory(sourcePath, outputPath);
          } else if (entry.isFile()) {
            this.emitFile({
              type: "asset",
              fileName: outputPath,
              source: await readFile(sourcePath),
            });
          }
        }
      };

      await emitWorkerImports(resolve(sdkDist, "browser-worker.js"), false);
      await emitDirectory(resolve(sdkDist, "../pkg/snippets"), "assets/snippets");
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
