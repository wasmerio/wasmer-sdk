# JavaScript SDK implementation

Status: multi-worker Node vertical slice complete  
Last updated: 2026-07-27

## Shape

The JavaScript SDK has two layers:

- `crates/wasmer-sdk-js` is a deliberately coarse `wasm-bindgen` facade over
  the public `wasmer-sdk` Rust API.
- `bindings/javascript` is the handwritten TypeScript API. It owns JavaScript
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
addressed through the shared linear memory. `client.shutdown()` closes the
scheduler and terminates both idle and busy workers.

Browser deployments must be cross-origin isolated so `SharedArrayBuffer` is
available. In practice that means serving appropriate COOP and COEP headers.

## Node networking

`bindings/javascript/src/node-network.ts` implements the Node transport with:

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

A sandbox only uses networking after the caller grants `network: true`;
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
import { Wasmer } from "@wasmer/sdk/node";

const client = new Wasmer();
const sandbox = await client.createSandbox({
  packages: ["python/python@3.12"],
  files: { "main.py": "print('hello')" },
});

const output = await sandbox
  .command("python", ["/workspace/main.py"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.shutdown();
```

Live processes use the same command:

```ts
const process = await sandbox.command("python", ["-u", "worker.py"]).spawn();

await process.stdin.write("first job\n");
await process.stdin.close();

for await (const line of process.stdout.lines()) {
  console.log(line);
}

await process.wait({ check: true });
```

Local packages are passed as bytes because a browser has no ambient host path:

```ts
const webc = new Uint8Array(await file.arrayBuffer());
const localPackage = await client.loadPackage(webc);

await using sandbox = await client.createSandbox({
  packages: [localPackage],
});

const output = await sandbox.command(localPackage).run({ check: true });
```

## Build and validation

```sh
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
rustup component add rust-src --toolchain nightly
cargo install wasm-bindgen-cli --version 0.2.126
cd bindings/javascript
npm install
npm run build
npm test
```

Validation currently covers:

- the native Rust SDK tests;
- a `wasm32-unknown-unknown` compile of the Rust facade;
- TypeScript strict type-checking;
- creation and shutdown of the Node WASM runtime;
- registry package loading and a finite WASIX command;
- concurrent blocking WASIX processes on distinct workers;
- real TCP and DNS calls through the Node bridge.

Two executable Node integration tests now mirror the native Rust server proofs:

```sh
npm run test:edgejs

WASMER_POSTGRES_WEBC=/absolute/path/postgres.webc \
  PSQL=/absolute/path/psql \
  npm run test:postgres

npm run test:workers
```

The PostgreSQL WEBC must contain the rebuilt WASIX module, its runtime root,
and initialized `PGDATA`, using the same manifest as the Rust proof. The test
starts PostgreSQL through the wasm-bindgen SDK and connects with the host's
standard `psql`; it contains no PostgreSQL protocol proxy.

The EdgeJS test serves a real HTTP response from
`wasmer/edgejs-quickjs`. The PostgreSQL test starts the WASIX PostgreSQL
process through the SDK, waits for its TCP listener, and runs the host's normal
`psql` binary against it. Both are green regression tests for the worker and
network architecture.

Two narrow upstream JS-target gaps are patched under `vendor/`:

- `virtual-fs` uses `web-time` for mount metadata on wasm32;
- Wasmer's JS module retains translated `ModuleInfo` instead of panicking when
  WASIX asks for it;
- WASIX signal callback registration tolerates a re-entrant JS-target callback
  instead of panicking on a nested instance-handle borrow;
- `wasmer-c-api-imports` is marked sendable on wasm32 under the worker
  scheduler's transfer invariant.

Those patches should be upstreamed and removed from this repository once
released.
