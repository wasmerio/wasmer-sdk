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

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
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

For an interactive shell or REPL, attach one terminal to the entire process
tree. Child packages inherit its TTY state and live streams:

```javascript
const bash = await sandbox
  .command("bash", ["-i"])
  .spawn({ terminal: { columns: 100, rows: 30 } });

if (!bash.stdin || !bash.stdout || !bash.stderr) throw new Error("no terminal");
terminal.onData((data) => void bash.stdin.write(data));
terminal.onResize(({ cols, rows }) => bash.resizeTerminal(cols, rows));
const pump = async (stream) => {
  for await (const chunk of stream) terminal.write(chunk);
};
void pump(bash.stdout);
void pump(bash.stderr);
```

Call `sandbox.close()` and `wasmer.close()` when a long-lived application no
longer needs them.

## Node.js networking and caching

Use `network: { mode: "host" }` when a package needs TCP or DNS:

```javascript
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/edgejs-quickjs@0.1.0"],
  network: { mode: "host" },
});
```

Node.js maps WASIX networking to `node:net` and `node:dns`. Its default
`.wasmer` cache uses the same registry and package layout as the Rust and
Python SDKs:

```javascript
const wasmer = new Wasmer({
  cache: { directory: ".cache/wasmer" },
});
```

Compiled WebAssembly engine artifacts are intentionally not shared with native
targets.

## Browser

Import the browser entrypoint:

```javascript
import { Wasmer } from "@wasmer/sdk2/browser";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
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

### Run a web server in an iframe

Browser sandboxes can expose an HTTP listener through a service worker. First,
make the SDK's worker available at the root of your origin. For example, copy
`node_modules/@wasmer/sdk2/dist/service-worker.js` to
`public/wasmer-service-worker.js`, or bundle this worker entry:

```javascript
import "@wasmer/sdk2/service-worker";
```

Register it with root scope, start the guest server, then expose its port:

```javascript
import { Wasmer } from "@wasmer/sdk2/browser";

const serviceWorker = await navigator.serviceWorker.register(
  "/wasmer-service-worker.js",
  { scope: "/", type: "module" },
);

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["php/php-32@8.3.2102"],
  network: { mode: "http" },
  files: { "index.php": "<h1><?php echo 'Hello from PHP'; ?></h1>" },
});

const php = await sandbox
  .command("php", ["-S", "0.0.0.0:8080", "-t", "/workspace"])
  .spawn({ stdout: "capture", stderr: "capture" });

const server = await sandbox.ports.expose(8080, { serviceWorker });
document.body.append(server.createIframe({ title: "PHP preview" }));
```

Shell-style applications can discover ports instead of knowing them in
advance:

```javascript
const stopWatching = sandbox.ports.onListen((port) => {
  void sandbox.ports
    .expose(port, { serviceWorker })
    .then((server) => document.body.append(server.createIframe()));
}, {
  onClose: (port) => console.log(`server on ${port} closed`),
});
```

`server.url` is also available for custom UI. The service worker follows the
iframe's browser client, so absolute links and subresource requests continue
to reach the same guest listener. Closing the server unregisters its route;
closing the sandbox closes all routes it owns.

The worker needs scope `/` to route absolute guest URLs. Guest documents share
the registration's origin, so serve untrusted HTML from a dedicated preview
origin rather than the origin containing privileged application state. The
SDK-generated iframe uses the capabilities required for scripts and service
worker control, but an iframe sandbox is not an origin boundary when both
`allow-scripts` and `allow-same-origin` are enabled.

## Examples

Run these from the repository root after `npm run build` in `js/`:

```console
node js/examples/python.mjs
node js/examples/multiple_runtimes.mjs
node js/examples/edgejs_http.mjs
node js/examples/postgres_psql.mjs
```

The complete browser PHP preview is in
[`examples/browser_php`](examples/browser_php).

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
npm run test:browser-http
```

`npm run check` type-checks the handwritten TypeScript API without rebuilding
the wasm module.
