# wasmer.sh

A fast, browser-native command shell powered by Wasmer, WASIX, and the new
[`@wasmer/sdk2`](../js) sandbox API.

The application loads `wasmer/bash`, creates one persistent sandbox, and
connects xterm to one long-lived interactive Bash process. Bash owns the
prompt, quoting, expansion, working directory, redirection, pipes, built-ins,
and child processes; the browser only transports terminal input and output.
Commands therefore have normal shell semantics instead of being parsed or
emulated by the UI:

```ts
const wasmer = new Wasmer();
const bashPackage = await wasmer.packages.load("wasmer/bash");
const sandbox = await wasmer.sandboxes.create({
  packages: [
    bashPackage,
    "wasmer/neatvi",
    "python/python",
    "wasmer/edgejs-quickjs@0.1.3",
    "php/php-32",
  ],
  files: { ".bashrc": "PS1='wasmer@web:\\w$ '" },
});

const bash = await sandbox.command(
  bashPackage,
  ["--rcfile", "/workspace/.bashrc", "-i"],
).spawn({ terminal: { columns: 100, rows: 30 } });
```

The default shell therefore exposes Unix utilities alongside `python`, `edge`
and `php`:

```console
echo "hello" > hello.txt && cat hello.txt
find /workspace -type f | sort | head
cat README.md
python -c "print('hello from Python')"
edge -e "console.log('hello from Edge.js')"
php -r "echo 'hello from PHP';"
cd php && php -S 0.0.0.0:8000 -t .
cd node && node server.js
cd python && python server.py
cd node-express && pnpm i && node server.js
cd next && pnpm i && pnpm dev
```

When a command opens an HTTP listener, wasmer.sh detects the port and opens a
live preview beside the terminal. The preview stays attached to the guest, so
absolute URLs and subresources are routed back to the same WASIX server.
The `node/`, `node-express/`, `next/`, `python/`, and `php/` directories are independent
examples with their own README files. `node/server.js` is backed by
`wasmer/edgejs-quickjs`; `python/server.py` uses Python's standard-library
`HTTPServer`. Closing a listener closes its preview automatically.

For an Express application, install the dependency inside the browser sandbox
and start the included server:

```console
cd node-express && pnpm i && node server.js
```

The server exposes `/`, `/api/hello`, and `/health`. Starting it opens the live
preview automatically; press Ctrl-C to stop the server and close the preview.

wasmer.sh can also attach the sandbox to a WISP proxy. This gives WASIX tools
real outbound TCP and DNS from the browser, multiplexed over one WebSocket. A
WASI-compatible Edge.js build can then run `pnpm` against the npm registry:

```console
cd node-express && pnpm i && node server.js
```

Running `python`, `edge`, or `php` without arguments lets each runtime detect
the inherited terminal and select its interactive mode. Their REPLs return
naturally to Bash when they exit.

Package data is persisted in the browser cache under the `wasmer.sh`
namespace, so subsequent sessions avoid downloading the same packages again.

The optional Editor panel uses a lean, lazy-loaded Monaco editor over the
sandbox's `/workspace` directory. Directories are read on demand, modified
tabs show an unsaved marker, and `Cmd+S` or `Ctrl+S` writes the active file
back to the sandbox. Monaco and its language grammars are not downloaded until
the panel is opened.

## Run locally

Build and start the WASIX Epoxy sidecar in one terminal:

```console
cd ../wisp-proxy
./build.sh
wasmer run . --net
```

Then start wasmer.sh in another terminal:

```console
pnpm install
VITE_WISP_URL=ws://127.0.0.1:4000/ pnpm dev
```

`pnpm dev` starts two independent servers. The shell runs at
`http://127.0.0.1:5173`, while a small static HTTP host runs at
`http://127.0.0.1:5174`. The latter owns the service worker and all guest HTTP
URLs, so guest routes never overlap Vite routes.

The service worker exposes one guest server at its origin root. It forwards
paths unchanged and never rewrites HTML or mounts the site beneath an SDK
prefix. A second guest needs another origin; production deployments can use a
wildcard domain to allocate one subdomain per active app.

The app server provides the COOP and COEP headers required for
`SharedArrayBuffer` and the worker-backed WASIX runtime. A production app host
must serve the same headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Build both static applications with:

```console
VITE_WASMER_SERVICE_WORKER_ORIGIN=https://http.wasmer.sh pnpm build
```

The shell is emitted to `dist/`; the standalone service-worker host is emitted
to `dist-service-worker/`. Deploy them to separate origins, then configure the
shell build with `VITE_WASMER_SERVICE_WORKER_ORIGIN`. The HTTP host must serve
`Cross-Origin-Resource-Policy: cross-origin`; its Vite preview configuration
does this automatically. A wildcard production setup can point the configured
origin at the domain responsible for guest HTTP traffic.

For a local production preview, build with
`VITE_WASMER_SERVICE_WORKER_ORIGIN=http://127.0.0.1:4174` and run
`pnpm preview`; it starts the two outputs on ports 4173 and 4174.

## Browser smoke test

Install Chromium once, then exercise a real registry package through the
browser terminal:

```console
npx playwright install chromium
npm test
```

The test verifies cross-origin isolation and WISP DNS, checks real Bash
arithmetic and file redirection, and exercises the Python and Edge.js REPLs
through Bash stdin. It starts an in-process WISP proxy by default. To exercise
the compiled WASIX sidecar instead, start it and run:

```console
WASMER_WISP_URL=ws://127.0.0.1:4000/ npm test
```

Set `WASMER_TEST_PNPM=1` to make the regression test additionally install and
load React through the proxy. A local Edge.js package can still be tested with
`WASMER_EDGEJS_WEBC`:

```console
WASMER_EDGEJS_WEBC=/absolute/path/to/edgejs-quickjs.webc \
WASMER_TEST_PNPM=1 \
WASMER_WISP_URL=ws://127.0.0.1:4000/ \
npm test
```

## URL parameters

By default, wasmer.sh opens its command prompt. It can also launch another
package entrypoint directly without rebuilding the site:

| Parameter | Meaning |
| --- | --- |
| `package` | Main registry package; defaults to `wasmer/bash` |
| `command` | Optional named command from the main package |
| `use` | Supporting package; repeat it to install several |
| `arg` | Process argument; repeat it to pass several |
| `wisp` | WISP WebSocket URL for outbound TCP and DNS |
| `httpOrigin` | Standalone Wasmer HTTP host origin; overrides the build-time setting |

For example:

```text
/?package=python/python&command=python&arg=-q
```
