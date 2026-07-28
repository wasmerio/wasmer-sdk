# Phase 2 decision log

Status: complete draft for review  
Last updated: 2026-07-27

The architectural decisions in
[Phase 1](../phase-1/decisions.md) remain in force.

| ID | Decision | Status |
| --- | --- | --- |
| DX-001 | Use `Sandbox` as the only execution boundary. Do not expose base `Wasmer.run()` or `Package.run()` operations in v1; running one command is short-lived use of an ordinary sandbox. | Accepted |
| DX-002 | Use an asynchronously created, instance-based `Wasmer` client. JavaScript users should not need a separate global `init()` call. | Accepted |
| DX-003 | Make packages—not language-specific interpreters or arbitrary host binaries—the unit of software distribution. Do not add `sandbox.python` or similar core APIs. | Accepted |
| DX-004 | Put `run` and `spawn` on a sandbox-created `Command`: `run` returns captured `Output`, while `spawn` returns a live `Process`. | Accepted |
| DX-005 | Never parse the canonical command argument as a shell command line. Commands and argument arrays remain distinct to avoid quoting ambiguity and accidental injection. | Accepted |
| DX-006 | Treat a nonzero guest exit as an execution result, not an SDK failure. Provide `check()` to opt into exception-style handling. | Accepted |
| DX-007 | Make captured output byte-oriented with convenient UTF-8 text decoding. Apply an output limit by default and report truncation. | Accepted |
| DX-008 | Use idiomatic host-language streaming abstractions. JavaScript byte streams guarantee `AsyncIterable`, add `lines()`, and expose Web Stream adapters; Rust uses asynchronous byte readers and writers. | Accepted |
| DX-009 | Prefer conceptual parity over mechanically identical APIs. Rust uses builders and `snake_case`; JavaScript uses async factories, options objects, and `camelCase`. | Accepted |
| DX-010 | Give a sandbox a writable `/workspace` default working directory and `/tmp`. Do not inherit host files, environment variables, working directory, or network access. | Accepted |
| DX-011 | Keep `command()` directly on `Sandbox`; put execution terminals on the returned `Command`. Group secondary facilities under `fs`, `ports`, and `capabilities`. | Accepted |
| DX-012 | Require explicit units in JavaScript option names such as `timeoutMs`, `lifetimeMs`, and `memoryBytes`. Rust uses typed durations and sizes. | Accepted |
| DX-013 | Define `close()` as deterministic cleanup. Rust `Drop` is best-effort; JavaScript also supports `AsyncDisposable` where the host supports it. | Accepted |
| DX-014 | Expose `Capabilities` and `preflight()` as normal product APIs. A requested guarantee that cannot be enforced causes creation or execution to fail. | Accepted |
| DX-015 | Keep guest network access disabled by default. Fine-grained network rules appear only on targets that can enforce them. | Accepted |
| DX-016 | Expose guest services through `ports.connect()` and capability-gated local forwarding. Do not promise a hosted public preview URL from an embedded SDK. | Accepted |
| DX-018 | Keep registry credentials host-side. Environment variables are ordinary guest-readable data and are never marketed as an opaque secret mechanism. | Accepted |
| DX-019 | Fail command lookup on ambiguous bare names introduced by multiple packages. Installation remains order-independent, and explicit package command references resolve collisions. | Accepted |
| DX-020 | Make package versions or digests pinnable everywhere. Tutorials may use stable aliases, but production and conformance examples use tested pins. | Accepted |
| DX-021 | Use structured errors with stable codes, operation context, and typed details. Do not make consumers parse prose. | Accepted |
| DX-022 | Keep target-specific features visible through capabilities and availability checks, while preserving one semantic model across Rust, browser JavaScript, Node.js, and UniFFI veneers. | Accepted |
| DX-023 | Keep a small v1 surface. Convenience recipes may compose the primitives, but should not become parallel execution models. | Accepted |
| DX-024 | Once a process starts, preserve timeout, limit, signal, and requested-termination outcomes in `Output` with bounded diagnostics. `check()` may convert them to typed errors. | Accepted |
| DX-025 | Aborting a wait does not implicitly kill an owned process. Process termination remains an explicit application decision. | Accepted |
| DX-026 | Make filesystem implementations mountable through an object-safe asynchronous Rust `FileSystem` trait. JavaScript exposes an equivalent `FileSystemProvider` contract through a bounded `wasm-bindgen` veneer. | Accepted |
| DX-027 | Ship a browser `BrowserFileSystem` adapter for `FileSystemDirectoryHandle` and OPFS roots. The application obtains permission; the SDK validates it and enforces the mount mode. | Accepted |
| DX-028 | Keep live external mounts distinct from imported `Directory` copies. If a live asynchronous bridge is unavailable, preflight fails instead of silently copying files. | Accepted |
| DX-029 | Use `<project-root>/.wasmer` as the default native desktop and Node.js cache, with the root captured at client creation and fully customizable. Browser and iOS use platform storage under the same logical contract. | Accepted |
| DX-030 | Cache portable package blobs independently from compiled artifacts. Partition compiled entries visibly by target and then by engine fingerprint. | Accepted |
| DX-031 | Treat `.wasmer` as disposable cache state and recommend ignoring it in source control. | Accepted |
| DX-032 | Authenticate native compiled entries with per-user provenance outside the checkout before calling Wasmer deserialization. If trust cannot be established, retain package caching and recompile. | Accepted |
| DX-033 | Keep `Command.run()` and `Command.spawn()` as separate terminal operations. Do not use `detached` or `background` booleans that change one method's return type. | Accepted |
| DX-034 | Use `timeoutMs` for a command deadline. Reserve `lifetimeMs` and `idleTimeoutMs` for sandbox lifecycle controls with independently specified semantics. | Accepted |
| DX-035 | Create a sandbox in a process-free state. Package entrypoints do not execute implicitly during sandbox construction. Service startup and readiness remain explicit operations. | Accepted |
| DX-036 | Keep a general code-interpreter or `runCode(language, code)` API above the core as a recipe or separate product surface. It composes packages, sandboxes, processes, and filesystems. | Accepted |
| DX-037 | Make `preflight()` validate the same complete `SandboxOptions` accepted by `createSandbox()`, including all packages, mounts, policies, and requested enforcement. | Accepted |
| DX-038 | For `spawn()`, default stdin to closed and stdout/stderr to bounded pipes. Request writable stdin explicitly; closing it sends EOF and does not terminate the process. | Accepted |
| DX-039 | Require applications to drain live stdout and stderr concurrently. `wait()` joins the process but does not implicitly close application-owned stdin or replace pipe backpressure with unbounded buffering. | Accepted |
| DX-040 | In JavaScript, make `sandbox.command(program, args?, options?)` return an immutable, reusable `Command` description. `run()` or `spawn()` starts a new process. | Accepted |
| DX-041 | Expose `sandbox.sh` and `sandbox.shell()` only over an explicitly configured shell command supplied by an installed package. Tagged `sh` interpolation escapes each value as argument data; `shell(script)` accepts trusted opaque script text. | Accepted |
| DX-042 | Expose `sandbox.installPackage(source)` and Rust `install_package(source)` for atomic installation after creation. It uses the normal resolver, returns the resolved `Package`, does not run package code, and leaves the sandbox unchanged on failure. | Accepted |
| DX-043 | Decode captured bytes synchronously. `CapturedOutput.text()` returns `string`; `Output.text()` checks the result and returns decoded stdout as the common-case convenience. | Accepted |
| DX-044 | Add `RunOptions.check`. `run({ check: true })` throws `ProcessExitError` for an unsuccessful completed process while retaining the same successful `Output` return type. Avoid parenthesized `(await run()).check()` examples. | Accepted |
| DX-045 | Make positional argv the concise JavaScript form: `command(selector, args, options?)`. Keep `command(selector, options?)` for commands without arguments. | Accepted |
| DX-046 | Resolve relative `SandboxOptions.files` keys and JavaScript filesystem paths against `/workspace`; retain absolute guest paths unchanged. `Directory.create()` resolves relative keys against the directory root. | Accepted |
| DX-047 | Accept `Package` as a `CommandSelector`, meaning its declared entrypoint. A package without one fails with `PACKAGE_HAS_NO_ENTRYPOINT`. | Accepted |
| DX-048 | Guarantee async iteration on JavaScript process output and add incremental `lines()` decoding. Web Streams remain available through explicit adapters. | Accepted |
| DX-049 | Configure live-output retention with `SpawnOptions.outputBytes` before the process starts. `Process.wait()` cannot retroactively change the retained diagnostic bound. | Accepted |

## Names deliberately rejected

- `exec(commandLine)` as the primary operation: it silently introduces shell
  parsing and cross-platform quoting problems.
- `Sandbox.create()` as a global static: it obscures registry, cache, and target
  configuration owned by a `Wasmer` instance.
- `runCode(language, code)` as a primitive: packages already describe the
  language runtime, dependencies, commands, and filesystem expectations.
- `Wasmer.run(package, options)` as a core shortcut: it gives `run` a second
  meaning and hides the sandbox that owns packages, mounts, policy, processes,
  and cleanup.
- `Package.run(options)`: immutable package content does not own mutable
  execution state.
- `kill()` as the only shutdown operation: graceful termination and forced
  termination have different meanings.
- `previewUrl(port)` in the universal contract: an embedded browser or native
  process cannot universally provision a public URL.

## Phase 3 validation gates

These decisions remain drafts until Phase 3 proves:

1. the proposed async shapes can be exposed cleanly through UniFFI;
2. async-iterable JavaScript byte streams, `lines()`, and Web Stream adapters
   can be implemented without buffering or ownership surprises;
3. deterministic close and cancellation work on every initial target;
4. the capability and preflight reports accurately reflect browser, Node.js,
   desktop Rust, and iOS behavior;
5. at least Python, Bash, EdgeJS QuickJS, and one background service package
   run through the same API without package-specific branches;
6. an OPFS root and a user-selected `FileSystemDirectoryHandle` can satisfy
   guest filesystem semantics without deadlocking a Wasmer worker;
7. permission revocation, concurrent access, flush/close, rename, truncation,
   and large chunked reads and writes behave predictably;
8. package and compiled cache hits survive client restart and stay isolated by
   target and engine fingerprint;
9. corrupted, incompatible, or unauthenticated native artifacts always become
   safe misses before Wasmer deserialization.
