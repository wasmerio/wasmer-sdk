import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
const wasmOpt =
  process.env.WASM_OPT ??
  join(packageRoot, "node_modules", ".bin", `wasm-opt${executableSuffix}`);
const wasmOutput = join(packageRoot, "pkg", "wasmer_sdk_js_bg.wasm");
const optimizedWasmOutput = `${wasmOutput}.optimized`;
const localWasmer = process.env.WASMER_REPO;
const localWasmerPatches = localWasmer
  ? [
      ["virtual-fs", "lib/virtual-fs"],
      ["virtual-mio", "lib/virtual-io"],
      ["virtual-net", "lib/virtual-net"],
      ["wasmer", "lib/api"],
      ["wasmer-c-api-imports", "lib/c-api-imports"],
      ["wasmer-config", "lib/config"],
      ["wasmer-package", "lib/package"],
      ["wasmer-types", "lib/types"],
      ["wasmer-wasix", "lib/wasix"],
      ["wasmer-wasix-types", "lib/wasi-types"],
    ].flatMap(([name, path]) => [
      "--config",
      `patch.crates-io.${name}.path=${JSON.stringify(join(localWasmer, path))}`,
    ])
  : [];

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
    ...(localWasmer ? [] : ["--locked"]),
    ...localWasmerPatches,
    "-p",
    "wasmer-sdk-js",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  {
    RUSTFLAGS: rustflags,
    CARGO_PROFILE_RELEASE_LTO: "fat",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "3",
  },
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
  "--remove-name-section",
  "--remove-producers-section",
]);
patchMemory32Glue(join(packageRoot, "pkg", "wasmer_sdk_js.js"));

run(wasmOpt, [
  wasmOutput,
  "-Oz",
  "--enable-bulk-memory",
  "--enable-threads",
  "--enable-mutable-globals",
  "-o",
  optimizedWasmOutput,
]);
renameSync(optimizedWasmOutput, wasmOutput);

function patchMemory32Glue(path) {
  const source = readFileSync(path, "utf8");
  let viewReplacements = 0;
  let pointerReplacements = 0;
  const patchedViews = source.replace(
    /(cached(?:DataView|Uint16Array|Uint8Array)Memory0)\.buffer !== wasm\.memory\.buffer/g,
    (_match, cache) => {
      viewReplacements += 1;
      return `${cache}.buffer !== wasm.memory.buffer || ${cache}.byteLength !== wasm.memory.buffer.byteLength`;
    },
  );
  const patched = patchedViews.replace(
    /(getDataViewMemory0\(\)\.set(?:BigInt64|Float64|Int32)\()arg0( \+)/g,
    (_match, prefix, suffix) => {
      pointerReplacements += 1;
      return `${prefix}(arg0 >>> 0)${suffix}`;
    },
  );
  if (viewReplacements !== 3) {
    throw new Error(
      `expected to patch 3 wasm-bindgen memory views, patched ${viewReplacements}`,
    );
  }
  if (pointerReplacements !== 22) {
    throw new Error(
      `expected to patch 22 wasm-bindgen return pointers, patched ${pointerReplacements}`,
    );
  }
  writeFileSync(path, patched);
}

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
