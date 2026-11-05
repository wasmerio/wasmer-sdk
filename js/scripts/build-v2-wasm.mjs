import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse B2's source-built threaded std/TLS recipe, with the SDK binding as the
// only producer. Never install/change a toolchain or mix worker asset revisions.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(packageRoot, "v2-bindgen/Cargo.toml");
const revisions = [...readFileSync(manifest, "utf8").matchAll(/rev = "([a-f0-9]{40})"/g)].map(match => match[1]);
if (!revisions.length || new Set(revisions).size !== 1) throw new Error("SDK runtime dependencies must share one exact revision");
if (!process.env.WASMER_REPO) throw new Error("WASMER_REPO must name a clean checkout of the pinned runtime source");
const runtimeRoot = resolve(process.env.WASMER_REPO);
const revision = run("git", ["rev-parse", "HEAD"], { cwd: runtimeRoot, capture: true }).trim();
if (revision !== revisions[0]) throw new Error(`runtime source ${revision} differs from SDK pin ${revisions[0]}`);
if (run("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: runtimeRoot, capture: true }).trim()) {
  throw new Error("runtime source must be clean before producing version-matched assets");
}
const taskTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(packageRoot, "../target/sdk-v2-browser"));
const output = join(packageRoot, "pkg-v2");
if (!existsSync(join(packageRoot, "v2-bindgen/Cargo.lock"))) {
  throw new Error("generate and review js/v2-bindgen/Cargo.lock before the locked browser build");
}
const nightly = "nightly-2026-08-08";
const directRustc = process.env.WASIX_BROWSER_RUSTC ?? run("rustup", ["which", "--toolchain", nightly, "rustc"], { capture: true }).trim();
if (!existsSync(directRustc)) throw new Error("the pinned nightly must already be installed");
const cargo = join(dirname(directRustc), "cargo");
const bindgen = process.env.WASM_BINDGEN;
if (!bindgen || run(bindgen, ["--version"], { capture: true }).trim() !== "wasm-bindgen 0.2.129") {
  throw new Error("WASM_BINDGEN must name the installed wasm-bindgen 0.2.129 binary");
}
// prepare-std.py asks rustc +<pin> for its sysroot. This task-local shim routes
// that read to the already installed direct binary, preventing rustup auto-install.
const shimRoot = join(taskTarget, "sdk-tooling");
mkdirSync(shimRoot, { recursive: true });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(join(shimRoot, "rustc"), `#!/bin/sh\n[ "$1" = ${quote(`+${nightly}`)} ] || exit 1\nshift\nexec ${quote(directRustc)} "$@"\n`, { mode: 0o755 });
const rustc = run("python3", [join(runtimeRoot, "lib/wasixv2/host/tests/browser/prepare-std.py"), taskTarget, nightly], {
  capture: true, env: { PATH: `${shimRoot}:${process.env.PATH}` },
}).trim();
const patches = [
  ["wasixv2", "api"], ["wasixv2-host", "host"], ["wasixv2-kernel", "kernel"],
  ["wasixv2-vfs", "vfs"], ["wasixv2-abi", "abi"], ["wasixv2-stdio-web", "stdio-web"],
].flatMap(([name, directory]) => ["--config", `patch.\"https://github.com/wasmerio/wasmer.git\".${name}.path=${JSON.stringify(join(runtimeRoot, "lib/wasixv2", directory))}`]);
const rustflags = [
  "-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals", "-Cpanic=abort",
  "-Clink-arg=--import-memory", "-Clink-arg=--shared-memory",
  "-Clink-arg=--initial-memory=4194304", "-Clink-arg=--max-memory=268435456",
  ...["__wasm_init_tls", "__tls_size", "__tls_align", "__tls_base"].map(name => `-Clink-arg=--export=${name}`),
].join(" ");
run("taskset", ["-c", process.env.WASIX_BROWSER_CPUS ?? "4-7", cargo,
  "build", "--locked", "--offline", "--manifest-path", manifest, ...patches,
  "-Zbuild-std=std,panic_abort", "--target", "wasm32-unknown-unknown", "-j3"], {
  env: { RUSTC: rustc, CARGO_INCREMENTAL: "0", CARGO_TARGET_DIR: taskTarget, RUSTFLAGS: rustflags },
});
mkdirSync(output, { recursive: true });
run(bindgen, [join(taskTarget, "wasm32-unknown-unknown/debug/wasmer_sdk_browser_v2.wasm"),
  "--target", "web", "--out-dir", output, "--out-name", "runtime"]);
for (const name of ["bootstrap", "coordinator", "worker", "timer-driver"]) {
  copyFileSync(join(runtimeRoot, `lib/wasixv2/host/src/browser/${name}.js`), join(output, `${name}.js`));
}
mkdirSync(join(output, "memory"), { recursive: true });
for (const name of ["client", "copy-worker", "operations"]) {
  copyFileSync(join(runtimeRoot, `lib/wasixv2/exec/src/memory/${name}.js`), join(output, `memory/${name}.js`));
}
copyFileSync(join(runtimeRoot, "lib/wasixv2/stdio-web/web-streams.mjs"), join(output, "web-streams.mjs"));
run(process.execPath, [join(runtimeRoot, "lib/wasixv2/host/tests/browser/inspect.mjs"), output]);
writeFileSync(join(output, "source.json"), `${JSON.stringify({ runtimeRevision: revision,
  sdkRevision: run("git", ["rev-parse", "HEAD"], { cwd: packageRoot, capture: true }).trim(),
  sdkDirty: Boolean(run("git", ["status", "--porcelain=v1"], { cwd: packageRoot, capture: true }).trim()),
  profile: "debug-threaded-blocking", taskLimit: 64, machineLimit: 8,
}, null, 2)}\n`);

function run(command, args, { cwd = packageRoot, capture = false, env = {} } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env },
    encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return result.stdout ?? "";
}
