# Invisible WKWebView prototype

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

This is a separate Swift package, not a change to the released macOS UniFFI
backend. It requires no native Wasmer JIT, native runtime XCFramework, or JIT
entitlement.

## Run the prototype

From the repository root, install the existing JS build prerequisites and
dependencies (`npm ci --prefix js`), then:

```sh
python3 swift/WebKitPrototype/scripts/prototype.py run --rebuild-wasm
```

The script uses `/Applications/Xcode.app` by default without changing the
system's selected developer directory. Set `DEVELOPER_DIR` to use another Xcode.
Xcode 27 and an installed iOS 27+ simulator are required. The runner rejects an
older SDK or simulator, including an explicitly selected iOS 26 device. Use
`--device <simulator-UDID>` to select one, or `--platform macos` for the macOS
diagnostic app (which also requires a JSPI-capable WebKit). Subsequent runs can
omit `--rebuild-wasm` until Rust changes. Generated runtime assets and app
bundles are ignored by Git.

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
and the native `WasmerWebKitPrototype` directory. A failed assertion exits the
runner with a nonzero status. Registry metadata requires internet access;
downloaded package bytes use a native cache.

For a physical device, run `prepare --rebuild-wasm`, add this directory as a
local Swift package to an iOS Xcode app, link `WasmerWebKit`, and use ordinary
development signing. The command-line `build --platform device` cross-compiles
an app but its ad hoc signature must be replaced with development signing to
install on a device. The consuming app needs `NSAppTransportSecurity` →
`NSAllowsLocalNetworking = YES` for its loopback HTTP asset origin.

## Swift interface

Prepare the bundled assets before building the Swift package:

```sh
python3 swift/WebKitPrototype/scripts/prototype.py prepare --rebuild-wasm
```

```swift
import WasmerWebKit

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
persist across commands. Persistent guest processes and worker-pool tuning
remain follow-up work.

## Checks

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  swift test --package-path swift/WebKitPrototype
node --test js/tests/host-filesystem.test.mjs
node --test swift/WebKitPrototype/scripts/memory-budget.test.mjs
node --test swift/WebKitPrototype/scripts/jspi.test.mjs
python3 -m unittest discover -s swift/WebKitPrototype/scripts -p 'test_*.py'
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

[Examples/iOSTerminal](../Examples/iOSTerminal) builds a native libghostty-vt
terminal on this runtime, with persistent Bash, Python REPL input, cowsay,
Node.js via Edge.js, resizing, and Ctrl-C. Node and Python HTTP servers open in
a separate visible preview WKWebView. `onListeningPortsChanged` reports guest
listeners; `handleHTTPRequest` forwards requests from `GuestHTTPServer` into
the guest. The execution WKWebView remains invisible and unattached.
