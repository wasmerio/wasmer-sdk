# JavaScript SDK implementation

Status: multi-worker Node vertical slice complete  
Last updated: 2026-07-30

## Shape

The JavaScript SDK has two layers:

- `js/bindgen` is a deliberately coarse `wasm-bindgen` facade over
  the public `wasmer-sdk` Rust API.
- `js/src` is the handwritten TypeScript API. It owns JavaScript
  conventions such as positional argv, synchronous text decoding,
  async-iterable process streams, checked runs, tagged-template shell escaping,
  and browser/Node entrypoints.

There is no N-API addon, child Wasmer CLI, or native Rust binding in the Node
path. The Rust SDK, Wasmer, and WASIX are compiled into
`wasm32-unknown-unknown` with Wasmer's `js` backend.

## Worker runtime

The facade uses the same essential execution model as `wasmer-js`: an
atomics-enabled wasm module, a shared linear memory, and a dynamic Web Worker
pool. The main JavaScript agent owns a scheduler with idle and busy queues.
Blocking WASIX work gets a dedicated worker; additional work starts additional
workers instead of parking the main agent.

Workers instantiate the same compiled SDK module with the same
`WebAssembly.Memory`. Scheduler messages structured-clone compiled guest
modules and guest memories where needed, while boxed Rust callbacks are
addressed through the shared linear memory. `client.close()` closes the
scheduler and terminates both idle and busy workers, and dropping the last
client reference closes them as a leak guard.

Browser deployments must be cross-origin isolated so `SharedArrayBuffer` is
available. In practice that means serving appropriate COOP and COEP headers.

## Node networking

`js/src/node-network.ts` implements the Node transport with:

- `node:dns/promises` for name resolution;
- `node:net` for outbound TCP connections;
- `node:net.Server` for WASIX TCP listeners;
- bounded pull-based reads between JS and `virtual-net`;
- readiness notifications from Node events into WASIX interest handlers.

The Node entrypoint passes this bridge to `WasmerCore.create()`. The bridge
stays on Node's main agent, where `node:net` can continue processing events
while a guest worker is blocked. Worker-side virtual sockets call it through a
small synchronous RPC protocol backed by `SharedArrayBuffer` and
`Atomics.wait`; readiness events call back into WASIX interest handlers in
shared Rust state.

Every bridge has a client-scoped ID. Main-agent hooks and worker RPC messages
carry that ID and resolve it through a bridge registry before touching a
descriptor. Consequently, independently allocated descriptor numbers cannot
collide across simultaneous `Wasmer` clients, and closing one client removes
only its listeners and sockets.

A sandbox only uses networking after the caller grants
`network: { mode: "host" }`;
otherwise the shared Rust core installs `UnsupportedVirtualNetworking`.

UDP is intentionally not represented as TCP. It remains unsupported until a
separate `node:dgram` adapter is implemented.

## Public API

Construction is synchronous. Runtime initialization starts on the first
asynchronous operation and is shared by all operations on that client. Use
`await client.ready()` when initialization errors should surface eagerly.
`await Wasmer.create(options)` remains as a compatibility factory.
`await using` remains an optional cleanup convenience, not the canonical
construction syntax.

```ts
import { Wasmer } from "@wasmer/sdk2/node";

const client = new Wasmer();
const python = await client.packages.load("python/python@3.12");
const sandbox = await client.sandboxes.create({
  packages: [python],
  files: { "main.py": "print('hello')" },
});

const output = await sandbox
  .command("python", ["/workspace/main.py"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.close();
```

Live processes use the same command:

```ts
const process = await sandbox
  .command("python", ["-u", "worker.py"])
  .spawn({ stdin: "pipe" });

await process.stdin.write("first job\n");
await process.stdin.close();

for await (const line of process.stdout.lines()) {
  console.log(line);
}

await process.wait({ check: true });
```

Spawn stdin defaults to `"closed"`; stdout and stderr default to bounded
`"pipe"` streams. `"capture"` retains bounded diagnostics without a live
reader, so a service process never blocks on an unread pipe. Readiness uses
the sandbox's own network policy:

```ts
await sandbox.ports.wait(port, { timeoutMs: 30_000 });
```

The timeout is one wall-clock deadline covering connection attempts and
retry delays. A successful probe opens and immediately closes a real TCP
connection, so one-shot and connection-count-sensitive services should expose
an application-level readiness signal instead.

The handwritten TypeScript layer validates every numeric public input before
calling wasm. Ports must be integers from 1 through 65535; timeouts and grace
periods must be non-negative safe integers; output-retention sizes must fit a
wasm32 `usize`. Invalid values fail with `WasmerError.code ===
"INVALID_ARGUMENT"`. The wasm-bindgen facade repeats these checks defensively
for callers that bypass the TypeScript layer.

Other machine-readable error codes are still provisional in this pre-1.0
implementation. Broad failures such as package loading, initialization, I/O,
execution, task scheduling, and internal state have distinct codes, but the
taxonomy is not presented as a stable cross-language contract yet.

Local packages are passed as bytes because a browser has no ambient host path:

```ts
const webc = new Uint8Array(await file.arrayBuffer());
const localPackage = await client.packages.load(webc);

await using sandbox = await client.sandboxes.create({
  packages: [localPackage],
});

const output = await sandbox.command(localPackage).run({ check: true });
```

## Package caching

Registry metadata and immutable WEBC package bytes are persistent by default.
Node stores them under `.wasmer`; the directory can be changed or made
read-only:

```ts
const client = new Wasmer({
  cache: {
    directory: "/var/cache/my-app/wasmer",
    readOnly: false,
  },
});
```

The Node layout is deliberately identical to the native Rust and Python
layout:

```text
.wasmer/
└── cache-v1/
    ├── registry/
    │   └── python#python
    └── packages/
        └── <sha256>.bin
```

This makes `.wasmer` a language-neutral acquisition cache: a package fetched
by a Python process can be consumed offline by Node, and vice versa. Package
blobs are addressed and verified by SHA-256; registry entries retain the same
JSON format and expiry rules on every host. JavaScript compilation artifacts
are intentionally excluded. Native Rust and Python may share their
target-specific compiled artifacts, while JavaScript leaves compilation
caching to the WebAssembly host.

Browsers use origin-scoped Cache Storage because they have no host directory.
`cache.namespace` separates applications within an origin. The logical
registry and package keys remain the same, but browser storage is not a
filesystem and therefore cannot be shared directly with native runtimes.

Use `cache: "memory"` for explicitly process-local behavior or `cache: false`
to disable persistent storage. Packages already loaded by the same client may
still be reused. Cache failures are treated as misses, so unavailable browser
storage or an unwritable Node directory does not prevent an otherwise valid
online package load.

## Build and validation

The native SDK and `js/bindgen` are members of one source workspace,
but they are intentionally built in separate invocations. Wasmer's native
`sys` and WebAssembly `js` features are mutually exclusive; do not select both
members with `cargo test --workspace`.

```sh
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
rustup component add rust-src --toolchain nightly
cargo install wasm-bindgen-cli --version 0.2.126
cd js
npm install
npm run build
npm test
```

From the repository root, the native command is:

```sh
cargo test -p wasmer-sdk --all-targets
```

Validation currently covers:

- the native Rust SDK tests;
- a `wasm32-unknown-unknown` compile of the Rust facade;
- TypeScript strict type-checking;
- creation and shutdown of the Node WASM runtime;
- registry package loading and a finite WASIX command;
- persistent Node package reuse from the same layout as Rust and Python,
  including a fresh-client offline load;
- Python execution, sandbox files, and live process streams in a real
  cross-origin-isolated Chromium page;
- persistent browser package reuse across fresh clients without network
  access;
- concurrent blocking WASIX processes on distinct workers;
- real TCP and DNS calls through the Node bridge.

The executable JavaScript integration tests cover browser execution, workers,
and the native Rust server proofs:

```sh
npm run test:edgejs
npm run test:browser

PSQL=/absolute/path/psql \
  npm run test:postgres

npm run test:workers
```

The test resolves `wasmer/pglite@0.1.0` directly, starts its entrypoint without
recreating its PostgreSQL arguments or environment, and connects through the
wasm-bindgen SDK's Node network bridge with the host's standard `psql`. It
contains no PostgreSQL protocol proxy.

The EdgeJS test serves a real HTTP response from
`wasmer/edgejs-quickjs`. The PostgreSQL test starts the WASIX PostgreSQL
process through the SDK, waits for its TCP listener, and runs the host's normal
`psql` binary against it. Both are end-to-end regression tests for the worker
and network architecture.

## Publishing

`.github/workflows/publish-npm.yml` publishes `@wasmer/sdk2` manually from the
`main` branch. The publish job runs on a GitHub-hosted runner in the `npm`
environment with `id-token: write`, uses npm 11.12.1, rebuilds the wasm-bindgen
and TypeScript artifacts, runs the Node regression suite under a hard
process-level deadline, inspects the package, and invokes `npm publish`
directly. It does not use or require an npm token.

Configure the package's npm trusted publisher with organization `wasmerio`,
repository `wasmer-sdk`, workflow filename `publish-npm.yml`, environment
`npm`, and permission for `npm publish`. These values are exact and
case-sensitive. The package must already exist before npm allows the trusted
publisher to be configured.

Four narrow upstream JS-target gaps are carried in the linked Wasmer checkout;
the SDK's Cargo patch table resolves the Wasmer ecosystem crates from that
monorepo rather than keeping source copies under `vendor/`:

- `virtual-fs` uses `web-time` for mount metadata on wasm32;
- Wasmer's JS module retains translated `ModuleInfo` instead of panicking when
  WASIX asks for it;
- WASIX thread-local instance handles and signal callback registration tolerate
  re-entrant JS-target access instead of panicking on nested borrows;
- `wasmer-c-api-imports` is marked sendable on wasm32 under the worker
  scheduler's transfer invariant.

Those patches should be upstreamed. Once released, the local Cargo patch table
can be removed.
