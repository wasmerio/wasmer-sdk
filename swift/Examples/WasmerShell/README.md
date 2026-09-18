# WasmerShell

A local Bash terminal for iOS 27+, with Node.js, Python, and cowsay. **libghostty-vt**
parses terminal output and encodes keys; a small UIKit view draws its cells.
The Wasmer SDK runs WASIX programs in an invisible, unattached WKWebView using
JSPI. No remote shell or terminal webpage is involved.

## Run

Requires an Apple Silicon Mac, Xcode 27 with an iOS 27 simulator, Zig **0.16.0**,
and Python 3 for the build script. The [WasmerSDK](../../WasmerWKSDK/README.md)
Swift package includes its runtime assets; Node and Rust are not required.

From the repository root:

```sh
python3 swift/Examples/WasmerShell/build.py run
```

The script builds libghostty-vt from a pinned upstream revision, links the
repository root’s `WasmerSDK` SwiftPM product and resource bundle, builds the app,
installs it, and opens Xcode’s simulator UI (Device Hub in Xcode 27). `DEVELOPER_DIR` defaults to
`/Applications/Xcode.app/Contents/Developer`; set it to use another Xcode.
Select a particular iOS 27+ simulator with `--device <UDID>`.

Tap the terminal or keyboard button to type. The toolbar provides Escape, Tab,
Ctrl-C, Ctrl-D, and arrow keys; hardware keyboards also work. Drag vertically to
scroll through history. The restart button creates a fresh shell.

Try:

```sh
cowsay 'Hello from iOS'
python
```

In the Python REPL, try `print(6 * 7)` or `input('Your name: ')`. Ctrl-D returns
to Bash. `python demo.py` runs the included interactive script and saves a file.
Shell builtins, pipelines, redirection, and the installed packages are available;
this example does not include a full Unix distribution.

`/native` maps to the app's `Documents/WasmerTerminal` directory and persists
between sessions. `/readonly` exposes the same directory read-only. Restarting
the shell retains files; removing the app removes its data.

## Run a server and open its browser

The app bundles the same dependency-free Node and Python HTTP examples as
[wasmer.sh](../../../wasmer-sh/workspace). They are copied into `/native/node/`
and `/native/python/` on first launch. Existing files are preserved.

```sh
cd /native/node && node server.js
# Or, from any directory:
python /native/python/server.py
```

The server listens on guest port 8000 and **automatically opens a visible
WKWebView**. The page and its absolute `/health` fetch are served by the running
WASIX process. Tap **Terminal** to return to the shell while keeping the server
running; Ctrl-C stops it and closes its preview. The globe menu runs either
example at the Bash prompt or reopens a running server's preview.

Use `PORT=3000 node /native/node/server.js` to choose another port. New listeners
are detected automatically; up to four previews can be retained at once.
To launch directly into a server demo from your Mac:

```sh
python3 swift/Examples/WasmerShell/build.py run --example node
# Or: --example python
```

As in wasmer.sh, the `node` command comes from **`wasmer/edgejs@0.2.0`**.
It provides Node-compatible APIs such as `node:http`; it is not an iOS build of
the upstream Node/V8 executable. A feature-detected shim supplies missing
`Symbol.dispose` / `Symbol.asyncDispose` identities before Node captures its
builtins; it does not add JavaScript `using` syntax to the host engine.
The terminal also provides native DNS and outbound TCP, so package downloads
use the iPhone's network connection without a WISP proxy. For example:

```sh
pnpm i react
node -e "console.log(require('react').version)"
```

TLS stays in the guest: Node performs its normal HTTPS and certificate
verification over the native TCP connection. Package compatibility still
depends on the WASIX/Edge.js runtime; native Node addons are not iOS binaries.

Python uses the same WASIX wheel index and pip settings as wasmer.sh. Plain
`pip install flask` installs into the persistent `/native/wasix-packages`
directory, which is included in `PYTHONPATH`. The bundled framework examples
also include their requirements:

```sh
pip install -r /native/python-django/requirements.txt
pip install -r /native/python-fastapi/requirements.txt
```

Pip requests binary wheels for `wasix_wasm32`; packages requiring a native
extension need a compatible WASIX wheel.

## Architecture

```text
UIKit keyboard → WasmerSDK → worker → WASIX terminal stdin
UIKit cells ← libghostty-vt ← native output callback ← stdout / stderr
                                  │
               hidden WKWebView: control page + SDK / guest workers
                                  │
                    native filesystem RPC → app Documents
```

`ShellRuntime.swift` is app orchestration built on `Wasmer`, `Sandbox`, and
`Process`. It loads packages, mounts the Documents directory, and spawns Bash
with `TerminalOptions`. Piped output uses `ProcessStream` with pull-based
backpressure; input uses `ProcessInput`. Input remains ordered, and dimensions
follow the view and keyboard through `resizeTerminal`.
The shell redirects stderr into stdout before entering interactive mode to
preserve the order of prompts, redraws, and program output. WASIX terminal
handling supplies line discipline and process-tree signals. Ghostty’s newline
mode handles the LF bytes emitted by the WASIX output pipe.

`GhosttyBridge.c` wraps libghostty-vt's C API. `TerminalView.swift` owns the VT
state, draws colors/styles and Unicode cells, handles scrollback, encodes keys,
and sends terminal query responses back to the guest. This is a UIKit renderer
using Ghostty's VT engine, not Ghostty's desktop Metal renderer.

The app watches `sandbox.ports.listening()` and calls `ports.expose(port)`.
Each returned `ExposedPort` provides an authenticated loopback URL for its
visible WebView. The internal HTTP bridge feeds the guest's in-memory TCP listener. Method,
path/query, headers, status, and binary bodies cross this bridge. Root-relative
links and subresources work without rewriting the guest HTML.

`NativeNetworkBridge` implements the SDK's existing host-network interface.
`NativeNetwork` resolves hostnames with the system resolver and owns nonblocking
Darwin TCP sockets on a dedicated queue. It supports IPv4/IPv6, partial reads
and writes, EOF, TCP_NODELAY, and keepalive. Worker readiness notifications
resume WASIX polling. The bridge buffers at most 1 MiB of received data and
256 KiB of queued writes per socket; messages carry up to 64 KiB at a time.
There are at most 64 sockets, with 30-second DNS/connect deadlines. A worker's
session ID prevents stale messages from using a replacement session's sockets;
exiting or restarting the runtime closes descriptors and cancels pending I/O.
Only the hidden runtime has access to this native bridge.

The visible browser has a separate nonpersistent data store and no native
message handlers. Its initial URL exchanges a random capability for an
HttpOnly cookie; the proxy strips that cookie before forwarding to the guest.
Closing a guest listener stops its proxy and dismisses the preview. The hidden
execution WKWebView remains unattached throughout.

## Validation

```sh
python3 swift/Examples/WasmerShell/build.py test
python3 swift/Examples/WasmerShell/build.py stress
python3 swift/Examples/WasmerShell/build.py stress --quick
python3 swift/Examples/WasmerShell/build.py build --platform device
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path swift/WasmerWKSDK
node --test swift/WasmerWKSDK/scripts/native-network.test.mjs
```

The simulator test drives a real Bash session, Python REPL and `input()`, EOF,
cowsay, terminal resizing, Ctrl-C, ANSI output, native file writes, and clean
exit. It checks rendered Ghostty cells and verifies that the WKWebView is never
attached to a window. It also runs Node, opens the actual Node and Python server
pages in a visible WKWebView, checks their `/health` fetches, POST/query
forwarding, Ctrl-C cleanup, and reuse of the same guest port. It resolves the
npm registry, fetches React metadata over HTTPS, runs `pnpm i react` in a fresh
project, imports React, and checks native socket cleanup. Results are saved
to `Artifacts/terminal-result.json`.
The test ends its shell; run `build.py run` afterward for an interactive session.

The stress test repeatedly reinstalls Flask, Django and FastAPI with the cache
disabled, imports the installed packages, drives 150 Python launches through the
UIKit keyboard path, types during a 2 MiB output burst, and restarts with input
pending. `--quick` replaces the network installs with 100 Python launches,
each creating and joining three threads.
Each command has a deadline; results are saved to
`Artifacts/terminal-stress-result.json`. Use a separate simulator with
`--device <UDID>` to keep stress-test package files out of your normal workspace.

Known stress failure on iOS 27.0 (24A434): the latest full run completed all 11
pip installs and 16 subsequent Python launches, then stopped with WebKit
`RangeError: Out of memory` (39 of 175 checks completed). This remains unresolved.
The failing allocation is a guest memory created during Bash fork, while the
SDK heap remains below its cap. A separate engine-only worker test reproduces
the allocation failure without Wasmer. See the
[memory investigation](../../../docs/ios-webkit-memory.md) and
[standalone probe](../WebKitMemoryProbe/README.md).
The separate 103-check quick run and 24 integration checks pass; these do not
establish stability for prolonged package-manager sessions.

The device command cross-compiles an ad-hoc-signed app; physical
installation requires development signing. Simulator validation does not
establish physical-device compatibility.

## Prototype limits and dependency

This is a foreground demo. iOS can suspend execution when the app backgrounds.
The initial package download and package-manager installs require internet
access. Native networking provides DNS and outbound TCP; UDP and native
inbound listeners are not implemented. Servers still use the HTTP preview bridge.
HTTP previews buffer responses (4 MiB maximum), accept fixed-length request
bodies up to 1 MiB, and time out after 30 seconds. WebSocket upgrades, streaming
uploads, and streaming responses such as SSE are not supported. This is not
yet a framework development server with HMR support.
The keyboard surface implements `UIKeyInput`, not full IME composition,
selection/copy, mouse reporting, or accessibility for individual terminal cells.
The renderer redraws the visible grid and is intended for a prototype.
Dimensions update guest terminal queries, but the current SDK does not emit
`SIGWINCH`; programs that depend on that signal may not redraw after a resize.

All 24 integration checks pass on the iPhone 18 Pro simulator running iOS 27.0
(24A434), including both visible server previews and the hidden-runtime check.
The device target also cross-compiles; a physical iPhone has not been tested. Native HTTP tests cover binary
POST bodies, query strings, status/headers, HEAD, preview authentication,
cross-origin rejection, and malformed or oversized request framing. Native
network tests cover DNS, IPv4/IPv6 TCP, binary transfers, EOF, refused
connections, pending-read cancellation, and session isolation. JavaScript tests
cover buffer limits, partial writes, readiness, and worker reply encoding.

libghostty-vt is built from [Ghostty](https://github.com/ghostty-org/ghostty) commit
`5de703a1b6ca0b91fcebe932b44be1df2de0a683`. Its C API is still evolving, so updates
require checking this wrapper. Ghostty is MIT licensed; the build copies its
license into the app as `Ghostty-LICENSE.txt`. Source and build caches under
`.build/`, app binaries, and test artifacts are ignored by Git. The SDK’s
JavaScript and WebAssembly resources are versioned with its Swift package.
