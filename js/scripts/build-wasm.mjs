import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const wasmBindgen =
  process.env.WASM_BINDGEN ??
  join(
    process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
    "bin",
    `wasm-bindgen${executableSuffix}`,
  );

const rustflags = [
  "-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals",
  "-Clink-args=--no-check-features",
  "-Clink-arg=--import-memory",
  "-Clink-arg=--shared-memory",
  "-Clink-arg=--max-memory=4294967296",
  "-Clink-arg=--export=__heap_base",
  "-Clink-arg=--export=__wasm_init_tls",
  "-Clink-arg=--export=__tls_size",
  "-Clink-arg=--export=__tls_align",
  "-Clink-arg=--export=__tls_base",
].join(" ");

run(
  "cargo",
  [
    "+nightly",
    "build",
    "-Z",
    "build-std=std,panic_abort",
    "-p",
    "wasmer-sdk-js",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { RUSTFLAGS: rustflags },
);

run(wasmBindgen, [
  join(
    workspaceRoot,
    "target/wasm32-unknown-unknown/release/wasmer_sdk_js.wasm",
  ),
  "--out-dir",
  join(packageRoot, "pkg"),
  "--out-name",
  "wasmer_sdk_js",
  "--target",
  "web",
  "--typescript",
]);

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
