# wasmer.sh

A fast, browser-native command shell powered by Wasmer, WASIX, and the new
[`@wasmer/sdk2`](https://www.npmjs.com/package/@wasmer/sdk2) sandbox API.

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
    "python/python@=3.13.5",
    "wasmer/edgejs@0.2.0",
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
`wasmer/edgejs@0.2.0`; `python/server.py` uses Python's standard-library
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
WASI-compatible Edge.js build can then run `pnpm` against the npm registry.
If no WISP endpoint is configured, the first outbound connection asks for one
and saves it in browser storage. A configured endpoint that cannot connect
opens the same prompt so it can be replaced without restarting the shell:

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

Start the published WASIX Epoxy proxy in one terminal:

```console
wasmer run wasmer/wisp-server --net
```

Then start wasmer.sh in another terminal:

```console
pnpm install
pnpm dev
```

The first command that needs outbound networking offers two setup paths: deploy
`wasmer/wisp-server` to Wasmer for free, or run it locally with the command
above and connect to `ws://localhost:4000/`. Set `VITE_WISP_URL` to configure
the endpoint at build time instead. Use the **Network** action in the header to
change the endpoint later without resetting the sandbox or its filesystem.

The deploy action passes the current shell origin's
`/wisp-autoconfigure/index.html`
bridge as `WISP_AUTOCONFIGURE`. Visiting the deployed WISP server redirects its
tab to that bridge with the WebSocket endpoint. The top-level bridge relays the
endpoint to an open wasmer.sh tab, which stores it and completes any pending
network prompt automatically. It must be top-level because browsers partition
cross-tab channels used by third-party iframes.

`pnpm dev` starts two independent servers. The shell runs at
`http://127.0.0.1:5173`, while a small static HTTP host runs at
`http://127.0.0.1:5174`. The latter owns the service worker and all guest HTTP
URLs, so guest routes never overlap Vite routes.

To run that standalone service-worker host through AnyBuild and Wasmer instead
of Vite, install [AnyBuild](https://www.anybuild.run/docs/installation/). From
the repository root, run:

```console
anybuild . --subdir wasmer-sh/service-worker --wasmer --start
```

AnyBuild selects `wasmer-sh/service-worker` as an independent Node static
application, runs its `build` script, publishes its `dist/` output, and runs
the static server with Wasmer at `http://127.0.0.1:8080`. Its generated
configuration and build state are separate from an AnyBuild build of the shell
itself. Start the shell in another terminal with:

```console
VITE_WASMER_SERVICE_WORKER_ORIGIN=http://127.0.0.1:8080 pnpm run dev:app
```

Set `PORT` before the AnyBuild command if port 8080 is unavailable, and use
the same port in `VITE_WASMER_SERVICE_WORKER_ORIGIN`.

The generated service-worker output includes an `sws.toml` file containing the
cross-origin headers required by the standalone HTTP host.

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
to `service-worker/dist/`. Deploy them to separate origins, then configure the
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

To exercise an externally hosted service worker, including the AnyBuild and
Wasmer command above, set `WASMER_SERVICE_WORKER_ORIGIN`:

```console
WASMER_SERVICE_WORKER_ORIGIN=http://127.0.0.1:8080 npm test
```

The focused Next.js regression installs the untouched npm SWC WebAssembly
package, starts the development server, and checks the rendered preview. A cold
run currently takes about three minutes:

```console
WASMER_EDGEJS_WEBC=/absolute/path/to/edgejs-quickjs.webc \
node tests/next-browser.mjs
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
/?package=python/python@=3.13.5&command=python&arg=-q
```
