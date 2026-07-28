# Phase 3: Rust SDK implementation

Status: first executable native vertical slice.

This phase implements the semantic Rust core before adding UniFFI and
`wasm-bindgen` veneers. The crate is named `wasmer-sdk` and imported as
`wasmer_sdk`.

## Implemented

- `Wasmer` client construction and shared shutdown state.
- A project-local `.wasmer` cache by default, with a configurable root.
- Separate package and compiled-module cache trees.
- Compiled artifacts partitioned by native target and engine family.
- Registry package resolution.
- Local package directories containing `wasmer.toml`.
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
- Network-free integration tests that create and execute a local Wasmer
  package.

## Current dependency baseline

The native implementation pins the coherent Wasmer 7.2.0 / WASIX 0.702.0
family and enables Cranelift. WASIX 0.702.1 currently pins Wasmer 7.2.1, while
the matching `wasmer-compiler-cranelift` 7.2.1 artifact is not available from
crates.io. Pinning avoids a misleading headless build that loads packages but
cannot compile a first-seen module.

The current resolved compiler dependencies require Rust 1.94 or newer.

## Deliberately not yet implemented

These remain part of the Phase 2 contract, but need their own executable
vertical slices rather than placeholder methods:

- live `Command::spawn()` streams, process termination, timeouts, and PTYs;
- memory, wall-time, process-count, and network policy enforcement;
- the public asynchronous filesystem-provider trait and live external mounts;
- native host-directory mounts;
- package download deduplication and cache locking across OS processes;
- cache inspection, pruning, and integrity maintenance;
- browser runtime construction and the browser File System API adapter;
- UniFFI and `wasm-bindgen` language veneers.

In particular, `spawn()` is not implemented using WASIX's existing unbounded
pipe as a shortcut. The SDK contract requires bounded stream queues,
backpressure, bounded diagnostic retention from process start, and reliable
termination. Those behaviors will be implemented and tested together.

## Validation

`tests/local_package.rs` builds a local WASI module from WAT, writes a
`wasmer.toml`, then verifies:

1. directory package loading without a registry;
2. first-use compilation through Cranelift;
3. finite stdin and captured stdout;
4. persistent `/workspace` files;
5. package and compiled-cache directory creation;
6. dynamic package installation;
7. package-as-entrypoint command selection; and
8. write-time output truncation.

