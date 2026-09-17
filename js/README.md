# `@wasmer/sdk`

Run Wasmer packages in Node.js or the browser with one package-first sandbox
API. The runtime is Wasmer + WASIX compiled to WebAssembly with
`wasm-bindgen`; Node.js does not load a native addon.

## Install

```console
npm install @wasmer/sdk
```

## Load or create a package from Wasm

For a single raw WASI/WASIX module, load its bytes directly:

```javascript
const pkg = await wasmer.packages.load(wasmBytes);
```

`load()` detects Wasm or WEBC from the bytes. A raw module must export `_start`;
the resulting package has one command named `main`, selected automatically as
its entrypoint. Run it with `sandbox.command(pkg)` or `sandbox.command("main")`.
WEBC packages retain their declared commands and entrypoint.

Use `packages.create()` to run a raw WASI/WASIX module without building a WEBC
archive. It works with the Node and browser entrypoints:

```javascript
const pkg = await wasmer.packages.create({
  modules: { app: wasmBytes }, // Uint8Array; for example, the result of readFile()
  commands: { hello: { module: "app" } },
  files: { "/data/config.json": '{"debug":true}' },
});
const sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
try {
  console.log((await sandbox.command(pkg, ["--help"]).run()).text());
} finally {
  await sandbox.close();
}
```

Each command references a named module exporting `_start`. A sole command is
inferred as the entrypoint; for multiple commands, set `entrypoint: "hello"`
or select `pkg.command("hello")`. Modules and files are captured during
creation. File paths must be absolute guest paths without `.` or `..` segments;
bundled files use private writable overlays during execution. Use `/workspace`
for persistent sandbox data. Close `wasmer` when finished.

To migrate from `Wasmer.fromWasm()`, use `packages.load(wasmBytes)` and run its
package in a sandbox. Use `create()` for custom command names or bundled files.
This API executes WASI/WASIX commands; it does not invoke arbitrary exports or
WebAssembly components.

## Run Python from Node.js

```javascript
import { Wasmer } from "@wasmer/sdk/node";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["python/python@=3.13.20"],
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

An unexpected worker failure stops the client's worker pool and completes its
active processes with a nonzero exit status. `wasmer.close()` rejects with
`WORKER_FAILED`, including when shutdown was already waiting for that worker.

## Node.js networking and caching

Use `network: { mode: "host" }` when a package needs TCP or DNS:

```javascript
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/edgejs@0.2.0"],
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
import { Wasmer } from "@wasmer/sdk/browser";

const httpHost = "https://http.example.com";
const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["python/python@=3.13.20"],
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

### Outbound networking through WISP

Browsers cannot open TCP sockets directly. Give a browser sandbox a WISP
endpoint to multiplex its WASIX TCP and DNS traffic over one WebSocket:

```javascript
import { Wasmer } from "@wasmer/sdk/browser";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/edgejs@0.2.0"],
  network: { mode: "wisp", url: "wss://proxy.example/wisp/" },
});

const output = await sandbox
  .command("pnpm", ["add", "is-number@7.0.0", "--ignore-scripts"])
  .run();
console.log(output.text());
```

The SDK opens the WISP connection lazily when the guest first requests DNS or
outbound TCP access. Browser applications can also supply or replace the
endpoint at that point:

```javascript
const sandbox = await wasmer.sandboxes.create({
  packages: ["curl/curl"],
  network: {
    mode: "wisp",
    requestUrl: async ({ url, error }) => {
      // Show application UI here. `url` and `error` are set after a failed
      // configured endpoint; return the WebSocket URL selected by the user.
      return await requestWispUrlFromUser({ url, error });
    },
  },
});
```

Concurrent guest connections share the same pending endpoint request. The SDK
owns one WISP connection per sandbox and routes networking from every WASIX
worker through it. Use a trusted, access-controlled proxy: it can observe
connection metadata and decide which destinations and ports are allowed.

Change an active sandbox's endpoint without recreating its filesystem or
process environment:

```javascript
sandbox.network.setWispUrl("wss://another-proxy.example/");
```

Existing WISP streams are closed. The replacement connection is opened lazily
on the next outbound network operation.

### Run a web server in an iframe

Browser sandboxes expose one HTTP listener at the root of a dedicated static
origin. By default, `ports.expose()` uses Wasmer's managed HTTP host at
`https://default.local.wasmer.site/`, so applications do not need to configure
or deploy one:

```javascript
const server = await sandbox.ports.expose(8080);
```

To operate a custom HTTP host, serve the worker as
`/wasmer-service-worker.js`:

```javascript
import "@wasmer/sdk/service-worker";
```

Serve a control document at `/.wasmer/host.html` which imports:

```javascript
import "@wasmer/sdk/service-worker-host";
```

The application itself stays on a different origin. Start the guest server;
omit the second argument to use the managed host, or pass `serviceWorker` to
override it:

```javascript
import { Wasmer } from "@wasmer/sdk/browser";

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["php/php-32@8.3.2102"],
  network: { mode: "http" },
  files: { "index.php": "<h1><?php echo 'Hello from PHP'; ?></h1>" },
});

const php = await sandbox
  .command("php", ["-S", "0.0.0.0:8080", "-t", "/workspace"])
  .spawn({ stdout: "capture", stderr: "capture" });

const server = await sandbox.ports.expose(8080);
document.body.append(server.createIframe({ title: "PHP preview" }));
```

Shell-style applications can discover ports instead of knowing them in
advance:

```javascript
const stopWatching = sandbox.ports.onListen((port) => {
  void sandbox.ports
    .expose(port)
    .then((server) => document.body.append(server.createIframe()));
}, {
  onClose: (port) => console.log(`server on ${port} closed`),
});
```

`server.url` is the HTTP-host origin root. Requests are forwarded with their
original path and body; the SDK does not rewrite HTML or add a path prefix.
One service worker exposes exactly one guest server. A second call using the
same origin fails until the first `BrowserServer` is closed. To serve guests
concurrently, assign each one its own origin (for example with wildcard
subdomains).

Pass a custom host explicitly when needed:

```javascript
const server = await sandbox.ports.expose(8080, {
  serviceWorker: "https://http.example.com",
});
```

See `wasmer-sh/service-worker` in this repository for a complete static Vite
build. The host document retains the sandbox connection and gives the service
worker a replaceable bridge. If the browser stops an idle service worker, the
next request reconnects through the live host document automatically. The
Wasmer runtime remains in the application page; closing that page ends the
server. Update both the service-worker and host-document bundles together.

`network: { mode: "wisp", ... }` includes this HTTP-listener support, so one
sandbox can serve a browser preview while making outbound connections.

The worker needs scope `/` to route absolute guest URLs. The SDK-generated
iframe uses the capabilities required for scripts and service
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
`wasm-bindgen` CLI. `npm ci` installs the pinned Binaryen toolchain used to run
`wasm-opt -Oz` as part of every JavaScript build:

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
