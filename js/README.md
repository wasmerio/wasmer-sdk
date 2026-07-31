# `@wasmer/sdk2`

Run Wasmer packages in Node.js or the browser with one package-first sandbox
API. The runtime is Wasmer + WASIX compiled to WebAssembly with
`wasm-bindgen`; Node.js does not load a native addon.

> `@wasmer/sdk2` is the temporary package name for the next Wasmer JavaScript
> SDK.

## Install

```console
npm install @wasmer/sdk2
```

## Run Python from Node.js

```javascript
import { Wasmer } from "@wasmer/sdk2/node";

const client = new Wasmer();
const sandbox = await client.sandboxes.create({
  packages: ["python/python@3.13.5"],
  files: {
    "main.py": "print(sum(number * number for number in range(10)))",
  },
});

const output = await sandbox
  .command("python", ["/workspace/main.py"])
  .run();

console.log(output.text());
```

`new Wasmer()` is synchronous. Package downloads, sandbox creation, commands,
and shutdown are asynchronous.

`run()` throws `ProcessExitError` for a non-zero exit, termination, or timeout
by default. Pass `{ check: false }` when the outcome is expected and should be
inspected as an `Output`.

For live processes, use `spawn()` and iterate the SDK streams directly:

```javascript
const process = await sandbox
  .command("python", ["-u", "-c", "print('ready')"])
  .spawn({ stdin: "pipe", stdout: "pipe", stderr: "capture" });

for await (const line of process.stdout.lines()) {
  console.log(line);
}

const result = await process.wait({ check: true });
```

Unlike `run()`, `process.wait()` is unchecked by default.

Call `sandbox.close()` and `client.close()` when a long-lived application no
longer needs them.

## Node.js networking and caching

Use `network: { mode: "host" }` when a package needs TCP or DNS:

```javascript
const sandbox = await client.sandboxes.create({
  packages: ["wasmer/edgejs-quickjs@0.1.0"],
  network: { mode: "host" },
});
```

Node.js maps WASIX networking to `node:net` and `node:dns`. Its default
`.wasmer` cache uses the same registry and package layout as the Rust and
Python SDKs:

```javascript
const client = new Wasmer({
  cache: { directory: ".cache/wasmer" },
});
```

Compiled WebAssembly engine artifacts are intentionally not shared with native
targets.

## Browser

Import the browser entrypoint:

```javascript
import { Wasmer } from "@wasmer/sdk2/browser";

const client = new Wasmer();
const sandbox = await client.sandboxes.create({
  packages: ["python/python@3.13.5"],
});
const output = await sandbox
  .command("python", ["-c", "print('Hello from the browser')"])
  .run();
```

Worker-backed WASIX execution requires a cross-origin-isolated page so the
browser can use `SharedArrayBuffer`. Serve the page with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

Browser package data is persisted with browser storage rather than the Node
filesystem cache.

## Examples

Run these from the repository root after `npm run build` in `js/`:

```console
node js/examples/python.mjs
node js/examples/multiple_runtimes.mjs
node js/examples/edgejs_http.mjs
node js/examples/postgres_psql.mjs
```

The PostgreSQL example requires `psql` on `PATH`; set `PSQL` or pass its path as
the first argument otherwise. All examples reuse the programs in
[`../fixtures/`](../fixtures).

## Build and test locally

Install Node.js 20 or newer, Rust nightly with `rust-src`, and the matching
`wasm-bindgen` CLI:

```console
rustup toolchain install nightly \
  --profile minimal \
  --component rust-src \
  --target wasm32-unknown-unknown
cargo +nightly install wasm-bindgen-cli --version 0.2.126 --locked

cd js
npm ci
npm run build
npm test
```

Run the network and browser regressions explicitly:

```console
npm run test:edgejs
npm run test:postgres
npx playwright install chromium
npm run test:browser
```

`npm run check` type-checks the handwritten TypeScript API without rebuilding
the wasm module.
