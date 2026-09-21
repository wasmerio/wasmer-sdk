# WasmerShell

A local Bash terminal for iOS 27+, with Node.js, Python, and cowsay. **libghostty-vt**
parses terminal output and encodes keys; a small UIKit view draws its cells.
The Wasmer SDK runs WASIX programs in an invisible, unattached WKWebView using
JSPI. No remote shell or terminal webpage is involved.

The header reuses wasmer.sh's Wasmer wordmark with an `.iOS` suffix. Controls,
terminal colors, and the Bash prompt follow the web shell's theme; the welcome
message uses the same format with iOS and Swift wording.

## Run

Requires an Apple Silicon Mac, Xcode 27 with an iOS 27 simulator, Zig **0.16.0**,
Node.js 20.19+ with npm, and Python 3 for the build script. This source example also needs the JS/Rust
build prerequisites from the [SDK guide](../../WasmerWKSDK/README.md#build-runtime-assets).
Published Swift releases supply a prebuilt runtime instead.

From the repository root:

```sh
npm ci --prefix js
python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm
python3 swift/Examples/WasmerShell/build.py run
```

The script builds libghostty-vt from a pinned upstream revision, links the
repository root’s `WasmerSDK` SwiftPM product and resource bundle, builds the app,
installs it, and opens Xcode’s simulator UI (Device Hub in Xcode 27). `DEVELOPER_DIR` defaults to
`/Applications/Xcode.app/Contents/Developer`; set it to use another Xcode.
Select a particular iOS 27+ simulator with `--device <UDID>`.

Choose an example to open its terminal, or **Open full shell** for all runtimes.
Tap the terminal or keyboard button to type. The toolbar provides Escape, Tab,
Ctrl-C, Ctrl-D, and arrow keys; hardware keyboards also work. Drag vertically to
scroll through history. The restart button creates a fresh shell.

In the full shell, try:

```sh
cowsay 'Hello from iOS'
python
```

In the Python REPL, try `print(6 * 7)` or `input('Your name: ')`. Ctrl-D returns
to Bash. `python demo.py` runs the included interactive script.
Shell builtins, pipelines, redirection, and the installed packages are available;
this example does not include a full Unix distribution.

Use the drive menu to choose **Native**, **Memory**, or **OPFS** storage. Changing
storage restarts the shell. All backends expose the same `/workspace` directory:

- Native (default) mounts `Documents/WasmerTerminal/<example-id>` at `/workspace`
  for a selected example, reusing its existing files. The full shell mounts
  `Documents/WasmerTerminal` and keeps all examples in named folders.
- Memory uses the SDK's shared in-memory filesystem, as in the browser, and
  clears files on restart. Guest file operations do not cross a storage bridge.
- OPFS stores file contents in WebKit's private filesystem, with metadata in a
  dedicated worker. Each selected example has its own OPFS volume; the full shell
  retains the original shared volume, including previously saved examples.
  Native and OPFS retain files between app launches.

Each backend has a separate workspace. Switching does not copy files between them.
`/native` and `/readonly` remain native directory mounts for the IO examples.
Removing the app removes its data.

## Run a server and open its browser

The app bundles the same dependency-free Node and Python HTTP examples as
[wasmer.sh](../../../wasmer-sh/workspace). Selecting an example copies its source
into `/workspace/node/` or `/workspace/python/` and opens that directory.
The full shell includes both. Existing files are preserved.

```sh
cd /workspace/node && node server.js
# Or, from any directory:
python /workspace/python/server.py
```

The server listens on guest port 8000 and **automatically opens a visible
WKWebView**. The page and its absolute `/health` fetch are served by the running
WASIX process. Tap **Terminal** to return to the shell while keeping the server
running; Ctrl-C stops it and closes its preview. The globe menu reopens a running
server's preview, and the grid button returns to the example picker.
The browser has back/forward buttons, reload/stop, and an editable address bar.
Enter a server path such as `/health` or `localhost:8000/docs` and tap **Go**.
Navigation stays within the preview's server, matching the web demo.

Use `PORT=3000 node /workspace/node/server.js` to choose another port. New listeners
are detected automatically; up to four previews can be retained at once.
To launch directly into a server demo from your Mac:

```sh
python3 swift/Examples/WasmerShell/build.py run --example node
# Or: --example python
```

### Next.js

Choose **Next.js** in the picker to open the shared wasmer.sh example in
`/workspace/node-next`. After `pnpm i` and `pnpm dev`, its page and
`/api/hello` route open automatically at `localhost:3000` in the browser preview.
You can also run it from the terminal:

```sh
cd /workspace/node-next
pnpm i
pnpm dev
```

Installation and execution use the same storage and runtime. No memory-limit
selection or restart is required. The pinned `wasmer/edge@0.2.1` release includes
the streaming-hash fix from [EdgeJS #153](https://github.com/wasmerio/edgejs/pull/153).
Use `build.py run --edgejs-webc /path/to/patched-edgejs.webc` to test local runtime
changes before publishing them.

This uses the Pages Router and Webpack with the matching SWC WebAssembly
fallback. The app bundles only source files and the lockfile. Run `pnpm i`
inside the terminal to download and install dependencies. No Node dependencies
or SWC binaries are bundled.
On the first `pnpm dev`, Next.js downloads its matching `@next/swc-wasm-nodejs`
compiler automatically. That first start needs network access. The package
manifest and scripts are shared with the browser example.
The example uses pnpm's hoisted layout and copies files because provider-backed
storage does not currently implement symlinks. Dependencies and edits persist on Native and
OPFS storage. Use the
preview’s Reload button after edits; the HTTP preview does not forward Next.js
WebSocket hot-reload traffic. Ctrl-C stops the server. To launch or test the
example from your Mac:

```sh
python3 swift/Examples/WasmerShell/build.py run --example node-next
python3 swift/Examples/WasmerShell/build.py test --example node-next --storage opfs
# Compare with --storage native
```

The `node` command comes from **`wasmer/edge@0.2.1`**.
It provides Node-compatible APIs such as `node:http`; it is not an iOS build of
the upstream Node/V8 executable. A feature-detected shim supplies missing
`Symbol.dispose` / `Symbol.asyncDispose` identities before Node captures its
builtins; it does not add JavaScript `using` syntax to the host engine.
The shim also adapts WebKit's captured stack text to the structured stack frames
used by Node dependencies. Receiver and function objects cannot be recovered
from that text.
The terminal also provides native DNS and outbound TCP, so package downloads
use the iPhone's network connection without a WISP proxy. For example:

```sh
pnpm i react
node -e "console.log(require('react').version)"
```

TLS stays in the guest: Node performs its normal HTTPS and certificate
verification over the native TCP connection. Package compatibility still
depends on the WASIX/Edge.js runtime; native Node addons are not iOS binaries.

Python uses the same WASIX wheel index and pip settings as wasmer.sh. A selected
example installs dependencies into its own `/workspace/.python-packages` directory, which
is included in `PYTHONPATH`. The full shell uses `/workspace/wasix-packages` and
includes every framework's requirements:

```sh
pip install -r /workspace/python-django/requirements.txt
pip install -r /workspace/python-fastapi/requirements.txt
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
               /workspace → Native RPC, SDK memory filesystem, or OPFS worker
```

`ShellRuntime.swift` is app orchestration built on `Wasmer`, `Sandbox`, and
`Process`. It loads packages, selects workspace storage, and spawns Bash
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

`build.py test --example storage --storage opfs` checks Swift/guest file sharing,
binary IO, directory rename, and persistence across a runtime restart. Use
`--storage native` or `--storage memory` for the same checks and timings.
The Next.js test starts from a fresh source-only directory with isolated pnpm
store/cache directories, so a previous install cannot hide download or hashing
failures. Add `--reuse-next-project` to test the existing `/workspace/node-next`
directory and shared pnpm cache without deleting its files. The test keeps one
runtime throughout installation and three server/page/API/Ctrl-C cycles, including
warm reinstalls and terminal recovery. Use `--next-runs 5` for a longer run.
It times installation, server readiness, and first page load independently.
The checks live in `Tests/IntegrationTests.swift`, which `build.py` compiles only
for `test` and `stress`; regular builds contain the terminal and examples.

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

The device command cross-compiles an ad-hoc-signed app; physical
installation requires development signing. Simulator validation does not
establish physical-device compatibility.

## Prototype limits and dependency

This is a foreground demo. iOS can suspend execution when the app backgrounds.
The initial package download and package-manager installs require internet
access. Native networking provides DNS and outbound TCP; UDP and native
inbound listeners are not implemented. Servers still use the HTTP preview bridge.
HTTP previews buffer responses (4 MiB maximum), accept fixed-length request
bodies up to 1 MiB, and allow up to 180 seconds for a guest response.
Incoming request headers and bodies must arrive within 35 seconds. WebSocket upgrades, streaming
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
JavaScript and WebAssembly resources are generated locally for this example and
packaged by CI in the Swift release's runtime XCFramework.

## Example picker

WasmerShell opens with a grid of Node.js, Express, Next.js, Python HTTP, Flask,
Django, FastAPI, FFmpeg, and yt-dlp templates. The catalog and sources are shared with
`wasmer-sh/examples.json` and `wasmer-sh/workspace`.

Selecting an example starts a shell with only that example's runtime packages,
copies missing source files directly into `/workspace`, and opens Bash there.
The terminal shows the install and run commands. Dependencies remain
user-installed; each Python example installs into its own
`/workspace/.python-packages` directory. yt-dlp loads Python, QuickJS-NG, and
FFmpeg. Run `/workspace/.python-packages/bin/yt-dlp --help`
for usage, then pass a video URL as an argument to download it. Run from
`/workspace` to load `yt-dlp.conf`, which enables QuickJS and configures
MP4 output in the example's `downloads` directory.

The FFmpeg example needs no installation. Its run command converts
`https://cdn.wasmer.io/media/wordpress.mp4` to `/workspace/wordpress.gif`,
creating a looping animation at 10 fps and 320 pixels wide. Its README also
shows how to inspect the GIF with FFprobe and convert a shorter clip.

The Django example uses the shared `manage.py` / `mysite` starter project and
Django's default welcome page. After installing requirements, run
`python manage.py runserver 0.0.0.0:8000 --noreload --nothreading`.
Run `python manage.py migrate` to initialize SQLite before using the admin.

Use the grid button to return to the picker and **Resume terminal** to keep the
current session. **Open full shell** loads all catalog runtimes plus cowsay in one shell.
Changing templates starts a new shell with a separate workspace; Native and
OPFS retain workspace files, while Memory starts fresh. Existing files are
never overwritten by templates.

Run the template isolation, Flask server, Django migrations/admin, FFmpeg
conversion, and yt-dlp tool/CLI checks:

```sh
python3 swift/Examples/WasmerShell/build.py test --example picker --storage memory
```

Set `SIMCTL_CHILD_WASMER_YTDLP_TEST_URL=<video-url>` when running that test to
also check a video download and FFmpeg merge. Remote site availability affects
this optional check.
