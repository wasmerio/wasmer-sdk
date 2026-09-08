import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "wasmer-sdk-bindgen-"));
try {
  // Keep the runner's CommonJS glue outside our ESM package, but let N-API's
  // inline JS resolve acorn from the installed SDK dependencies.
  symlinkSync(
    join(packageRoot, "node_modules"),
    join(temporaryRoot, "node_modules"),
    "junction",
  );
  const result = spawnSync(
    "cargo",
    [
      "+nightly",
      "test",
      "--locked",
      "-p", "wasmer-sdk-js",
      "--lib",
      "--target", "wasm32-unknown-unknown",
      "tasks::interop::tests",
    ],
    {
      cwd: resolve(packageRoot, ".."),
      env: {
        ...process.env,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER:
          process.env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER ??
          "wasm-bindgen-test-runner",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
