import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
  server: {
    // WASIX has no native filesystem notification API, so use Vite's portable
    // stat-based watcher for the development server.
    watch: { usePolling: true },
  },
  build: {
    // Lightning CSS only ships native Node addons. Rolldown itself is WASM-native.
    cssMinify: false,
  },
});
