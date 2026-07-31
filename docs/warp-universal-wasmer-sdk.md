# WARP: Universal Wasmer SDK

**Status:** Draft

**Decision requested:** Review the architecture, public object model, binding strategy, and repository boundaries before expanding the implementation to more languages.

## Introduction

This WARP proposes a universal, embedded SDK for running Wasmer packages from Rust, JavaScript, Python, Swift, and other host languages.

The SDK is package-first. Applications provide a registry package, local WEBC file, in-memory package, or local package directory; compose it into a `Sandbox`; then execute commands as captured runs or live processes. The same model is intended to run short scripts, interactive tools, HTTP servers, and long-lived services such as PostgreSQL compiled to WASIX.

One Rust crate implements package resolution, sandbox state, filesystems, processes, networking policy, and caching directly on Wasmer and WASIX. Language bindings are deliberately thin:

- Rust uses the core API directly.
- JavaScript compiles the core to WebAssembly through `wasm-bindgen`. It does not use a native Node addon.
- Python and, eventually, Swift use a coarse UniFFI facade with a handwritten language-native API on top.
- BoltFFI is implemented in parallel as an evaluation, not yet as the primary Python boundary.

The Rust, Node.js, and Python vertical slices are working. They execute registry and local packages, support live process I/O, filesystems, package installation, termination, and host networking. End-to-end proofs run an Edge.js HTTP server and a WASIX PostgreSQL server that is reached by a normal host `psql` client.

## Motivation

Wasmer can already execute the same package across several targets, but embedders currently need to understand target-specific runtime setup, filesystem composition, WASIX process management, worker scheduling, and network adaptation. Reimplementing those concerns in every host language creates subtly different products with different failure modes.

A shared SDK provides:

- **One behavioral contract.** Packages, commands, output, streams, mounts, ports, errors, and lifecycle have the same meaning in every language.
- **Portable package workflows.** The abstraction is not tied to Python, JavaScript, or a shell. Any Wasmer package can expose one or more commands.
- **A smaller correctness surface.** Process termination, bounded output, caching, package resolution, and filesystem semantics are implemented once.
- **Native developer experience.** Rust uses traits and Tokio I/O; JavaScript uses promises, async iteration, and typed options; Python uses `asyncio`, context managers, and Python source types.
- **Incremental product reach.** A core capability added in Rust can become available to several language SDKs without reimplementing the runtime.
- **Embedded deployment.** The SDK runs inside the host application. It does not require a Wasmer CLI subprocess, native Node binding, protocol proxy, or remote sandbox service.

From a product perspective, this turns the Wasmer package ecosystem into a consistent application platform rather than a collection of runtime-specific APIs. A package author can target one execution model while SDK users choose the host language and deployment environment that fits their product.

## Explanation

### Public model

The shared vocabulary is intentionally small:

- `Wasmer` owns runtime configuration, package resolution, and caches.
- `Packages` and `Sandboxes` expose client-scoped acquisition and creation operations.
- `Package` is a resolved, reusable package and may select its own entrypoint.
- `Sandbox` owns installed packages, `/workspace`, mounts, environment, network policy, and live processes.
- `Command` is a reusable command description.
- `Output` is the bounded result of a completed command.
- `Process` provides live stdin, stdout, stderr, wait, terminate, and kill.
- `FileSystem` is a mountable host filesystem capability.

Client construction is synchronous; operations that may resolve packages, compile code, or perform I/O are asynchronous. Explicit close methods remain available for deterministic cleanup, while sandbox ownership ensures live processes are not detached accidentally.

There is no client-level `run()`. Execution belongs to a sandbox because even a one-shot command needs package composition, filesystem state, policy, caching, and deterministic process cleanup. A convenience `run()` at the client would either hide those decisions or create a second execution model.

`run()` and `spawn()` instead live on `Command`:

```ts
const wasmer = new Wasmer();
const python = await wasmer.packages.load("python/python@3.12");
const sandbox = await wasmer.sandboxes.create({
  packages: [python],
  files: { "main.py": "print('hello')" },
});

const output = await sandbox
  .command("python", ["/workspace/main.py"])
  .run();

console.log(output.text());
```

The same command can be spawned when live I/O is required:

```ts
const process = await sandbox
  .command("python", ["-u", "-c", "print(input().upper())"])
  .spawn({ stdin: "pipe" });

await process.stdin.write("hello\n");
await process.stdin.close();

for await (const line of process.stdout.lines()) {
  console.log(line);
}

await process.wait({ check: true });
```

`Command.run()` treats success as its default contract and raises a typed `ProcessExitError` containing the completed output on non-zero exit, termination, or timeout. Callers opt out with `check: false` when failure is expected. `spawn()` and `Process.wait()` remain process-oriented and return every outcome as data unless explicitly checked.

Captured byte decoding is synchronous because the bytes are already in memory. Live streams are async-iterable and expose a `lines()` helper. Output retention is bounded from process creation, so an unread or excessively noisy guest cannot grow host memory without limit.

### Packages and commands

A package source is one of:

- a registry reference such as `python/python@3.12`;
- a local WEBC file or package directory on hosts with ambient filesystem access;
- in-memory WEBC bytes, including browser `File` contents; or
- an already resolved `Package`.

Packages can be installed while a sandbox is live. A `Package` is also a command selector: selecting the package runs its entrypoint, or returns a clear error if it has none. Named commands remain available for multi-command packages.

The SDK does not automatically invent a shell. `sandbox.shell(script)` is only available when the caller installs and selects a shell package. JavaScript also exposes a tagged-template `sh` helper that escapes interpolated values as single arguments; opaque shell strings remain an explicit operation.

### Filesystems

Every sandbox has a persistent in-memory `/workspace`. Relative file keys and filesystem paths resolve beneath it:

```ts
files: { "main.py": "print('hello')" }
```

Host mounts are capabilities, not path strings embedded in the runtime. The Rust `FileSystem` trait defines the provider contract, while bindings map it to language-appropriate interfaces. This permits:

- host directory mounts on native targets;
- in-memory directories;
- custom application-backed filesystems; and
- a browser provider backed by the File System Access API.

Mounts declare their guest path and read-only or read-write mode. The guest sees a normal WASIX filesystem; the provider receives paths relative to its mount root.

### Networking and processes

Networking is disabled unless the sandbox explicitly requests host networking. Native targets use Wasmer's host networking. Node.js supplies a client-scoped bridge over `node:net` and `node:dns`; WASIX still owns the guest socket and protocol implementation.

Blocking WASIX work in JavaScript runs in a dynamic Web Worker pool using a shared WebAssembly memory. Multiple blocking guest processes therefore use multiple workers rather than serializing behind one worker or blocking the main JavaScript agent. Node network requests carry a client identifier so two live `Wasmer` clients cannot mix descriptors.

`sandbox.ports.wait()` uses one wall-clock deadline covering connection attempts and retry delays. A successful readiness probe opens and closes a real TCP connection, which is documented because it matters to one-shot or connection-count-sensitive servers.

### Caching

The default cache is `.wasmer` at the project root and is configurable. It has two independent layers:

- registry metadata plus content-addressed downloaded package artifacts; and
- compiled artifacts partitioned by target, engine, and compatibility identity.

Target partitioning is required because native Cranelift artifacts, browser WebAssembly artifacts, and future mobile artifacts are not interchangeable. Cache behavior is an implementation concern of `Wasmer`, not a second public package-management API.

Native language bindings use the Rust cache directly. A UniFFI client therefore shares registry metadata, package blobs, and compiled artifacts with a Rust client that uses the same cache root.

`wasmer.lock` is intentionally outside the initial proposal. Reproducible resolution is valuable, but introducing lockfile ownership before the package and cache contracts stabilize would couple several independent design decisions.

### Architecture and bindings

The core calls Wasmer directly. There is no general host-adapter layer between the SDK and Wasmer; such a layer would mostly duplicate Wasmer's existing runtime traits while obscuring which capabilities are actually target specific.

| Layer | Responsibility |
| --- | --- |
| `wasmer-sdk` | Package, sandbox, process, filesystem, network policy, cache |
| UniFFI/BoltFFI facade | Coarse FFI-safe objects and boundary conversions |
| `wasm-bindgen` facade | WebAssembly exports, worker integration, JS network RPC |
| Handwritten language API | Idiomatic types, naming, validation, streams, errors |

Wasmer's native `sys` and WebAssembly `js` backends are mutually exclusive build profiles. They share source and contract tests, but are built in separate target-specific invocations.

The handwritten language layer is important. Generated FFI is an internal transport, not the product API: it should not force Rust ownership details, millisecond integers, handle registries, or generated naming conventions onto Python and Swift users.

### Repository boundaries

The repository is organized by the surface that developers build and release:

```text
/
├── Cargo.toml
├── rust/
│   ├── src/
│   ├── examples/
│   ├── tests/
│   ├── uniffi/
│   └── boltffi/
├── js/
│   ├── src/
│   ├── bindgen/
│   ├── examples/
│   ├── tests/
│   └── scripts/
├── python/
│   ├── src/wasmer_sdk/
│   ├── examples/
│   ├── tests/
│   └── scripts/
└── docs/
```

The Rust core and native FFI crates are colocated because they share Cargo ownership and native release concerns. The `wasm-bindgen` crate lives under `js/` because its output, worker scripts, and versioning belong to the npm package. Python owns its handwritten API and packaging rather than mixing them with generated Rust code. Swift will receive a top-level directory when its package exists.

This layout makes each language reviewable as a product while keeping the single runtime implementation visible.

### Current implementation status

Implemented and exercised:

- Rust core SDK with registry, file, byte, and directory package sources;
- reusable commands, captured output, live streams, termination, and cleanup;
- sandbox filesystem operations and external provider mounts;
- live package installation and package entrypoint selection;
- project-local package and target-separated compilation caches;
- JavaScript `wasm-bindgen` build with a multi-worker scheduler;
- client-scoped Node TCP/DNS networking;
- Python UniFFI API with the same object structure;
- BoltFFI Python prototype;
- Edge.js HTTP execution through Rust, Node.js, and Python; and
- socket-enabled WASIX PostgreSQL started by the SDK and reached by host `psql`.

Still deliberately incomplete:

- Swift packaging and proof of concept;
- full browser conformance for external filesystem providers;
- a mature cross-language error taxonomy;
- enforceable CPU and memory limits on every target;
- UDP in the Node network bridge;
- lockfiles, snapshots, terminals, and observability APIs; and
- production release automation and platform wheel/XCFramework matrices.

## Drawbacks & Alternatives

### Drawbacks

- **Rust becomes the semantic center.** This prevents implementation drift, but core changes require careful FFI design and cross-target compilation.
- **Targets cannot be perfectly identical.** Browsers lack ambient host paths, Node needs a network bridge, and mobile platforms impose distribution and execution constraints. The contract must expose capabilities rather than pretend all features are universal.
- **The JavaScript artifact is operationally demanding.** Shared memory and workers require cross-origin isolation in browsers and add scheduler and RPC complexity.
- **Generated bindings do not solve packaging.** UniFFI still needs platform native artifacts. BoltFFI currently emits CPython-version-specific wheels.
- **Explicit sandboxes add one object to simple examples.** This is modest ceremony, but it keeps policy, state, and cleanup visible and avoids a separate shortcut model.
- **A shared cache needs strict compatibility keys and concurrency rules.** Incorrect reuse would be worse than recompilation.

### Alternatives

1. **Implement each SDK directly against Wasmer.** This gives each language maximum freedom, but duplicates difficult lifecycle and runtime code and makes behavioral drift likely.
2. **Use UniFFI for every language, including JavaScript.** This can serve native Node.js, but cannot provide the intended browser SDK and would make Node depend on a native addon.
3. **Compile the Rust SDK to WebAssembly for every host language.** This avoids native distribution but gives Python and Swift an unnatural runtime, expensive data crossings, and weaker host integration.
4. **Introduce a general host-adapter abstraction.** This appears flexible, but duplicates Wasmer runtime traits and adds indirection without removing target-specific code.
5. **Expose only `client.run(package, options)`.** This is attractive for a hello-world case, but obscures filesystem and network policy, makes live processes awkward, and creates a second lifecycle beside `Sandbox`.
6. **Build a remote sandbox service instead of an embedded SDK.** A service can enforce stronger isolation and centralized limits, but it is a different product with network latency, infrastructure, authentication, and data-residency concerns. The embedded SDK can later be used to implement such a service.

## Summary & Conclusion

<stub>
Summarize review feedback and the final accepted decision here.
</stub>
