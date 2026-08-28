# Phase 3: Rust SDK implementation

Status: native package, process, stream, and external-filesystem slices.

This phase implements the semantic Rust core beneath the UniFFI and
`wasm-bindgen` veneers. The crate is named `wasmer-sdk` and imported as
`wasmer_sdk`.

## Implemented

- `Wasmer` client construction and shared shutdown state.
- A project-local `.wasmer` cache by default, with a configurable root.
- Registry metadata cached for ten minutes, matching the Wasmer CLI policy.
- Content-addressed WEBC blobs reused across fresh clients and processes.
- Resolved registry packages reused in memory within one client.
- Compiled artifacts persisted across native clients and partitioned by target,
  engine family, engine fingerprint, and artifact format.
- Registry package resolution.
- Local package directories containing `wasmer.toml`.
- Local package `[fs]` host mappings during spawned execution.
- Copy-on-write local package roots so guest writes cannot mutate package
  payloads, with explicit child mappings remaining writable.
- Local WEBC files and in-memory WEBC bytes.
- Process-free sandbox creation.
- A persistent in-memory `/workspace`, including relative file seeding.
- Atomic `Sandbox::install_package()` after sandbox creation.
- Bare command selection with ambiguity errors.
- Package-qualified commands and `Package` as an entrypoint selector.
- `std::process::Command`-style arguments, environment, current directory,
  finite stdin, and captured execution.
- Nonzero exit codes represented as `Output`, with `Output::check()` for typed
  failure.
- Synchronous `CapturedOutput::text()` and checked `Output::text()`.
- Per-command output retention configured before execution. Retention is
  enforced while the guest writes, and each stream reports truncation.
- `Command::spawn()` with bounded live stdin, stdout, and stderr queues.
- Single-owner process streams implementing Tokio's asynchronous I/O traits.
- Diagnostic stdout and stderr retained independently of live stream reads.
- Idempotent `Process::wait()` and nonblocking `Process::try_wait()`.
- Graceful termination with timed escalation to `SIGKILL`.
- Immediate `Process::kill()`, revocable stdin, and kill-on-drop ownership.
- Sandbox-owned process tracking: `Sandbox::close()` kills live processes.
- An object-safe asynchronous `FileSystem` and `File` provider contract.
- Explicit `ReadOnly` and `ReadWrite` external mount modes.
- Provider capabilities intersected with guest mount rights.
- A portable mutable `Directory` provider.
- A native adapter from the stable SDK provider API to Wasmer's VFS.
- `NetworkPolicy::Disabled` backed by an unsupported virtual network.
- Explicit `NetworkPolicy::Host` for unrestricted native guest sockets.
- WebAssembly C API host imports used by `syrusakbary/edgejs-quickjs-wasi`.
- Network-free integration tests that create and execute a local Wasmer
  package.

## Current dependency baseline

The native implementation pins the coherent Wasmer 7.2.1 / WASIX 0.702.1
family and enables Cranelift. This family also supplies the WebAssembly C API
host imports required by `syrusakbary/edgejs-quickjs-wasi`.

The current resolved compiler dependencies require Rust 1.94 or newer.

Recent vertical slices on top of that baseline:

- `Output.reason` distinguishes guest exits from SDK termination and
  timeouts; synthesized statuses no longer masquerade as guest exit codes.
- `Command::timeout()` enforces a spawn-time deadline through the portable
  task-manager timer and completes the process with `ExitReason::TimedOut`.
- `Stdio::Capture` retains bounded diagnostics with no live reader, so
  captured runs and service spawns need no drain tasks.
- Sandbox-wide environment values via `SandboxBuilder::env()`/`envs()`,
  merged beneath per-command overrides.
- `Sandbox::ports().wait(port, timeout)` probes a guest TCP listener through
  the sandbox's own virtual networking, failing closed when networking is
  disabled.
- `SandboxFileSystem` gained `create_dir`, `read_dir`, `stat`, `remove`, and
  `rename`.
- `Error::code()` exposes the current cross-language error code. The
  taxonomy remains provisional until the pre-1.0 implementation can
  distinguish important causes consistently on every target;
  `ProcessExitError` names the termination reason and includes a bounded
  stderr excerpt.
- `Process::handle()` returns a cloneable signaling handle whose `kill` and
  `terminate` never contend with a concurrent `wait()`.
- `SandboxBuilder::mount()` accepts any provider or `Arc<dyn FileSystem>`
  without manual coercion.

## Deliberately not yet implemented

These remain part of the Phase 2 contract, but need their own executable
vertical slices rather than placeholder methods:

- PTYs;
- memory, process-count, and restricted-network policy enforcement;
- native host-directory mounts;
- package download deduplication and cache locking across OS processes;
- cache inspection, pruning, and integrity maintenance;
- browser runtime construction and the browser File System API adapter;
- Swift packaging and its handwritten veneer.

Live streams deliberately do not use WASIX's existing unbounded pipe. A
byte-bounded, wake-based SDK pipe provides backpressure without a blocking
mutex, while a separate write-time capture retains only the configured
diagnostic limit.

The provider-to-Wasmer adapter in this slice is native-only in behavior:
Wasmer's synchronous metadata/open calls dispatch the asynchronous provider
operation onto the SDK runtime and block only the guest worker until it
completes. A browser provider must use the later worker-owned protocol and
must not block the JavaScript event loop.

## Validation

`tests/local_package.rs` builds a local WASI module from WAT, writes a
`wasmer.toml`, then verifies:

1. directory package loading without a registry;
2. first-use compilation through Cranelift;
3. finite stdin and captured stdout;
4. persistent `/workspace` files;
5. native compilation artifacts are written on first execution;
6. a fresh client deserializes the existing artifact without rewriting it;
7. dynamic package installation;
8. package-as-entrypoint command selection; and
9. write-time output truncation.

A focused client test uses a mock registry to prove that the first registry
load fetches metadata and one WEBC, a repeated load in the same client is
memory-only, and a fresh client resolves and loads the package with zero HTTP
requests. The UniFFI crate repeats the two-client compilation test through its
exported facade, proving that it inherits the Rust cache rather than creating a
binding-specific cache.

`tests/process.rs` additionally verifies:

1. live stdin and EOF;
2. concurrently consumed stdout and stderr;
3. bounded stream queues;
4. retained diagnostics after live reads;
5. repeated waits;
6. graceful termination with escalation; and
7. sandbox cleanup of live processes.

`tests/external_mount.rs` runs guest Wasm against an SDK `Directory` mounted at
`/external`. It verifies live provider reads and writes and confirms that a
read-only mount rejects the same guest write without mutating the provider.

`tests/local_package_mount.rs` verifies that a spawned command can read a
child `[fs]` mapping beneath a local package root, can write to its guest root,
and cannot mutate the host package payload through that root.

The [PostgreSQL WASIX proof](postgres-wasix.md) runs the compiled Oliphaunt
PostgreSQL 18.4 command through `wasmer-sdk` with a writable `PGDATA`; the WASIX
guest binds a loopback TCP socket, and a native standard `psql` connects
directly to it. No protocol proxy is involved.

`rust/examples/edgejs_http.rs` loads `syrusakbary/edgejs-quickjs-wasi`, seeds a small
Node-compatible HTTP server into `/workspace`, enables guest host networking,
starts the package entrypoint as a live process, and verifies the response from
the native host before terminating the server.
