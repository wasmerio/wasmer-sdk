# WasmerWKSDK for iOS

An experimental **iOS 27+** backend that runs **Python** using the existing
Wasmer JS/WASIX runtime and WebAssembly JavaScript Promise Integration (JSPI).
[Safari 27 introduces JSPI](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes).
The coordinator verifies an actual Wasm suspend/resume across a timer before
Python can start; API presence alone is insufficient. The pinned Wasmer backend
already detects JSPI in guest workers.

`WKWebView` is a private implementation detail:
it has a zero frame, is hidden, and is **never added to a view or window**.
Only public Apple APIs are used. [`WKPreferences.inactiveSchedulingPolicy = .none`](https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.property)
allows execution while the view is detached; it does not grant iOS background
execution time when the application itself is suspended.

`WasmerWKSDK` is a SwiftPM product in the repository's root package. It bundles
its JavaScript and WebAssembly resources; adding it to an app requires **no npm,
Rust build, asset preparation, or JIT entitlement**. The native macOS product
remains `WasmerSDK`. This directory also provides a standalone local package
for developing and testing the WebKit backend.

## Add to an iOS app

Use Xcode 27+, Swift 6, and an **iOS 27.0** deployment target. In Xcode, choose
**File → Add Package Dependencies**, enter
`https://github.com/wasmerio/wasmer-sdk.git`, select the branch containing this
feature, and add the **WasmerWKSDK** product to the app target. The existing
`wasmer-sdk-swift-v0.2.1` tag predates this product; use the PR branch
`codex/wasmer-shell-ios` until it is merged, then `main` until a Swift release
includes iOS.

For a Swift package consumer:

```swift
// Package.swift
platforms: [.iOS("27.0")],
dependencies: [
    .package(url: "https://github.com/wasmerio/wasmer-sdk.git",
             branch: "codex/wasmer-shell-ios"),
],
// Inside your target's dependencies:
.product(name: "WasmerWKSDK", package: "wasmer-sdk")
```

A commit SHA can be used with `revision:` for a fixed dependency. For local
work, add the repository root or `swift/WasmerWKSDK` as a local package.
SwiftPM embeds the `Web` resource directory automatically; do not copy scripts
or Wasm files into the app yourself. The `WasmerWKSDK` product does not link the
macOS-only UniFFI library or depend on Ghostty.

Add the following to the app's Info.plist for the private loopback origin:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

Keep the runtime alive for the session and call `await runtime.close()` when
finished. Use its APIs on the main actor; guest execution and native I/O happen
outside the main thread. Nothing needs to be added to the app's view hierarchy.

## Run the prototype

From the repository root (the runtime assets are already bundled):

```sh
python3 swift/WasmerWKSDK/scripts/prototype.py run
```

The script uses `/Applications/Xcode.app` by default without changing the
system's selected developer directory. Set `DEVELOPER_DIR` to use another Xcode.
Xcode 27 and an installed iOS 27+ simulator are required. The runner rejects an
older SDK or simulator, including an explicitly selected iOS 26 device. Use
`--device <simulator-UDID>` to select one, or `--platform macos` for the macOS
diagnostic app (which also requires a JSPI-capable WebKit). App bundles and
test artifacts are ignored by Git; the SwiftPM runtime assets are checked in.

The native demo displays progress and Python's output. There is no WebView in
its UI. The automated probe:

1. Asserts isolation, `SharedArrayBuffer`, actual JSPI suspension, and an
   unattached WebView.
2. Waits five seconds with the view detached before starting Python.
3. Runs `python/python@=3.13.20` with the bundled `python-smoke.py` script.
4. Exercises a Python thread with dynamic module imports and native file I/O,
   a child process, binary file roundtrips, and read-only mount rejection.
5. Verifies actual output files from Swift, changes the native input, then
   repeats after five more seconds idle, using the same invisible WebView.
6. Closes workers, native descriptors, and the loopback listener.

The simulator result is saved to `Artifacts/simulator-result.json`. The app's
Documents directory contains `prototype-result.json`, `prototype-progress.txt`,
and the native `WasmerWKSDKProbe` directory. A failed assertion exits the
runner with a nonzero status. Registry metadata requires internet access;
downloaded package bytes use a native cache.

For a physical device, add the package to an iOS Xcode app and use ordinary
development signing. The command-line `build --platform device` cross-compiles
an app with an ad hoc signature; installing it needs development signing.

## Swift interface

```swift
import Foundation
import WasmerWKSDK

// On the main actor. Execution and native filesystem work happen off it.
let directory = URL.documentsDirectory.appendingPathComponent("Python")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
try Data("hello from native Swift\n".utf8)
    .write(to: directory.appendingPathComponent("input.txt"))
let runtime = try HeadlessWasmer(directory: directory)
do {
    let capabilities = try await runtime.start()
    assert(!capabilities.webViewAttached)
    // runPython throws an actionable error if the JSPI probe failed.
    let output = try await runtime.runPython("""
        import sys
        from pathlib import Path
        value = Path('/native/input.txt').read_text()
        Path('/native/output.txt').write_text(value.upper())
        print(sys.argv[1], value)
        """, arguments: ["Hello, iOS 27!"])
    print(output.stdout)
    await runtime.close()
} catch {
    await runtime.close()
    throw error
}
```

`runPython` accepts source text and arguments, passed through WebKit's structured
argument API without JavaScript string interpolation. It returns captured stdout,
stderr, exit code, and termination reason. `runCowsay` remains available as the
earlier filesystem/redirection probe. The runtime accepts one command at a time. Swift task
cancellation closes the entire prototype runtime; create a new instance to
restart against the same native files.

## Execution and I/O

```text
Swift async API
  ↕ WKScriptMessageHandlerWithReply / callAsyncJavaScript
Detached WebView control page
  ↕ postMessage / SharedArrayBuffer / Atomics
SDK coordinator worker → WASIX guest workers
  ↕ host filesystem provider RPC, through the control page
NativeFileSystem actor → app-owned directory
```

JSPI handles guest suspension within Wasmer. The existing native filesystem
transport still uses synchronous worker RPC with `SharedArrayBuffer`/`Atomics`;
enabling JSPI does not remove the shared-memory or isolation requirements.

The control page stays responsive while workers wait on native filesystem
operations. `/native` is writable; `/readonly` exposes the same directory with
read-only rights enforced on both sides. Native paths use descriptor-relative
`openat` operations with `O_NOFOLLOW` on each component. Symlinks are unsupported.
File IDs, offsets, bytes, and metadata cross the bridge; guest pointers do not.
Transfers are limited to 64 KiB per read/write, responses to 512 KiB, with a
30-second worker bridge timeout. This prototype uses JSON byte arrays rather
than a tuned binary transport.

The loopback server binds only to `127.0.0.1`, uses a random URL token, and serves
COOP/COEP headers. Package download URLs are restricted to content-addressed
Wasmer CDN artifacts. Native `URLSession` downloads verify SHA-256 before
caching or serving bytes to the runtime. Downloads are capped at 128 MiB to
accommodate the Edge.js package. The terminal example combines the SDK's HTTP
ingress with native DNS and outbound TCP. `NativeNetwork.swift` uses the system
resolver and nonblocking Darwin sockets; `Web/native-network.js` implements the
existing host-network ABI and worker readiness notifications. TLS remains in
the guest. Buffers are bounded (1 MiB receive / 256 KiB send per socket), native
I/O messages carry at most 64 KiB, and DNS/connect operations time out after
30 seconds. Worker sessions own their descriptors and close pending operations
on teardown. UDP and native inbound listeners are not implemented. The visible
server browser has no access to this native message handler.

Each shared guest memory is limited to 128 MiB. The separate SDK runtime heap
starts at 25 pages (1.5625 MiB) and grows on demand up to 512 MiB, because it
also holds decoded packages and linked modules. Python exhausted the previous
128 MiB SDK cap during startup. These are not total process-memory limits.
The pinned Wasmer backend otherwise requests guest
memories with an almost 2 GiB maximum, including during fork. On the simulator,
the second command failed while allocating `{initial: 133, maximum: 32767,
shared: true}`, despite an initial size of only about 8 MiB. The prototype's
`memory-budget.js` caps these maxima in the coordinator and guest workers.
A smaller imported-memory maximum is valid in WebAssembly, but this workaround
does not update Wasmer's internal `MemoryType` metadata. Production integration
should expose the limit through Wasmer's JS backend.

Each completed command also closes its sandbox and SDK and releases its
coordinator worker and guest workers. Native files and the invisible WebView
persist across commands. Interactive terminals keep their worker and processes alive until shell exit.
Worker-pool tuning remains follow-up work.

## Updating the bundled runtime

Consumers do not run these steps. Maintainers changing the Rust or JavaScript
SDK should install its build prerequisites (see [the JS SDK](../../js/README.md)),
then regenerate and commit the bundled runtime:

```sh
npm ci --prefix js
python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm
python3 swift/WasmerWKSDK/scripts/bundle_sdk.py --check
```

`Web/sdk/manifest.json` records the SDK version, source fingerprint, and SHA-256
of each bundled file. The bundler includes only the worker modules, generated
glue and its imported snippets, Wasm, and licenses. CI checks the fingerprint
and resource hashes so source changes cannot silently leave the bundle stale.

## Checks

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  swift test --package-path swift/WasmerWKSDK
node --test js/tests/host-filesystem.test.mjs
node --test swift/WasmerWKSDK/scripts/memory-budget.test.mjs
node --test swift/WasmerWKSDK/scripts/jspi.test.mjs
python3 -m unittest discover -s swift/WasmerWKSDK/scripts -p 'test_*.py'
cargo test -p wasmer-sdk --test external_mount
```

Unit checks cover native byte I/O, confinement, read-only rights, teardown,
HTTP isolation headers, worker wakeup for errors and oversized replies,
instantiation with the smaller shared-memory maximum, JSPI execution and failure
detection, and rejection of incompatible simulators. JSPI unit tests require a
JSPI-capable Node runtime (Node 26 was used during development).
The simulator probe exercises the actual Apple WebKit/Wasm/native bridge.

Verified on an iPhone 18 Pro simulator running iOS 27.0 (24A434): the JSPI
suspend/resume probe passed, both Python commands exited with code 0 and empty
stderr, and the WebView remained unattached. Both runs passed the thread,
subprocess, native text/binary I/O, and read-only checks. Swift verified changed
native input on the second run; the bridge handled 92 filesystem operations.
The SDK heap grew to 163.1875 MiB in each command. The registry package is pinned
to `python/python@3.13.20`; its interpreter reports CPython 3.13.15.
The iOS 27 device target also cross-compiles successfully.

A simulator pass does not establish physical-device memory limits or sustained
background execution. Device testing is still required before release.

## Interactive terminal example

[WasmerShell](../Examples/WasmerShell) builds a native libghostty-vt
terminal on this runtime, with persistent Bash, Python REPL input, cowsay,
Node.js via Edge.js, resizing, and Ctrl-C. Node and Python HTTP servers open in
a separate visible preview WKWebView. `onListeningPortsChanged` reports guest
listeners; `handleHTTPRequest` forwards requests from `GuestHTTPServer` into
the guest. The execution WKWebView remains invisible and unattached.
