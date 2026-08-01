# Wasmer SDK

Run real software inside lightweight WebAssembly sandboxes from JavaScript,
Python, or Rust.

The Wasmer SDK turns packages from the
[Wasmer registry](https://wasmer.io/products/registry) into composable
sandboxes. Add Python, PostgreSQL, Edge.js, PHP, shell tools, or your own
package; give the sandbox files and capabilities; then run commands or keep
long-lived processes under your control.

```javascript
import { Wasmer } from "@wasmer/sdk2/node";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["python/python@3.13.5"],
  files: { "hello.py": "print('Hello from Wasmer')" },
});

const output = await sandbox
  .command("python", ["/workspace/hello.py"])
  .run();

console.log(output.text());
```

The same package, sandbox, command, process, filesystem, and port model is
available in every language SDK.

## What can you run?

- **Unix commands in an interactive browser shell** —
  [wasmer.sh application](wasmer-sh)
- **A PHP website rendered from a browser WASIX server** —
  [JavaScript service-worker example](js/examples/browser_php)
- **Python 3.13** — [JavaScript example](js/examples/python.mjs),
  [Python example](python/examples/python.py),
  [Rust example](rust/examples/python.rs)
- **A Node.js-compatible HTTP server with Edge.js** —
  [JavaScript example](js/examples/edgejs_http.mjs),
  [Python example](python/examples/edgejs_http.py),
  [Rust example](rust/examples/edgejs_http.rs)
- **PostgreSQL 18 with a standard native `psql` client** —
  [JavaScript example](js/examples/postgres_psql.mjs),
  [Python example](python/examples/postgres_psql.py),
  [Rust example](rust/examples/postgres_psql.rs)
- **Python, Edge.js, PHP, and shell tools in one sandbox** —
  [JavaScript example](js/examples/multiple_runtimes.mjs),
  [Python example](python/examples/multiple_runtimes.py),
  [Rust example](rust/examples/multiple_runtimes.rs)

The examples share the guest programs in [`fixtures/`](fixtures), so each SDK
runs the same Edge.js server, Python program, and PostgreSQL query.

## One small, composable API

A `Wasmer` client owns package resolution, workers, networking, and the local
cache. `wasmer.packages` resolves reusable packages.
`wasmer.sandboxes.create()` composes packages, files, environment variables,
mounts, and network access into an isolated workspace.

Commands belong to a sandbox:

- `command(...).run()` captures a finite command and fails on an unsuccessful
  exit by default.
- `command(...).spawn()` starts a live process with stdin, stdout, stderr,
  termination, and exit status.
- `sandbox.fs` reads and writes the guest filesystem.
- `sandbox.ports` waits for guest services without inventing a separate server
  abstraction.
- `sandbox.installPackage()` adds software after the sandbox has started.

There is deliberately no client-level `run()` shortcut. Every execution has an
explicit sandbox, which keeps package composition, files, capabilities, and
process lifetime visible.

JavaScript and Python callers can pass `check: false` or `check=False` when a
non-zero status is expected. Spawned-process `wait()` remains unchecked so
applications can inspect every exit reason directly.

## Pick your SDK

| Language | Package | Guide |
| --- | --- | --- |
| JavaScript | `npm install @wasmer/sdk2` | [JavaScript SDK](js/README.md) |
| Python | `pip install wasmer-sdk` | [Python SDK](python/README.md) |
| Rust | Workspace/Git while crate publishing is disabled | [Rust SDK](rust/README.md) |

JavaScript runs Wasmer and WASIX directly in WebAssembly through
`wasm-bindgen`; Node networking is bridged through `node:net` and `node:dns`,
not a native addon. Python uses the Rust SDK through a Python-independent
UniFFI library. Rust uses Wasmer natively.

## Fast, shared package caching

The SDK uses `.wasmer` in the working directory by default. Native Rust,
Python, and Node.js clients share the same registry metadata and downloaded
package data. Native compiled artifacts live in target-specific cache
partitions, while JavaScript keeps its runtime-specific data separate.

Set a different cache root when an application needs another location. Commit
neither `.wasmer` nor compiled artifacts to source control.

## Local development

Each SDK guide contains its own build and test commands:

- [Build and test JavaScript](js/README.md#build-and-test-locally)
- [Build and test Python](python/README.md#build-and-test-locally)
- [Build and test Rust](rust/README.md#build-and-test-locally)

CI runs the Rust and UniFFI foundation first, then JavaScript and Python in
parallel. Cargo outputs, Wasmer registry/package data, and target-specific
compiled artifacts are cached independently.

The SDK is currently alpha. Its cross-language shape is intentional, but error
codes and less common capabilities may still evolve. For the architectural
rationale, read the
[Universal Wasmer SDK WARP](docs/warp-universal-wasmer-sdk.md).
