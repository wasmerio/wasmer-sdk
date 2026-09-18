# WebKit shared Wasm memory probe

An engine-only reproduction of shared WebAssembly memory allocation failure.
It creates no Wasm module and loads no Wasmer SDK, Rust, WASIX, Python, or JSPI.
The iOS app runs its WKWebView unattached, and displays only diagnostic text.

A producer repeatedly allocates a shared memory with an 8.3125 MiB initial size
and 128 MiB maximum. In `shared` mode it sends each memory to one receiver in a
worker pool; the receiver touches one byte and acknowledges the message. In
`local` mode it allocates the same memory and exchanges the same acknowledgment,
but does not send the memory. Neither mode stores previous memories.

## iOS simulator

Requires Python 3, Xcode 27, and an iOS 27+ simulator. Use a dedicated simulator;
the script installs and restarts `io.wasmer.memory-probe`. It does not modify
WasmerShell. `DEVELOPER_DIR` defaults to `/Applications/Xcode.app/Contents/Developer`.

```sh
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID>
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --mode local
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --delay-ms 10
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --recycle-every 20
```

The script builds a small Swift app, serves the JavaScript over host loopback
with COOP/COEP headers, waits for its result, and saves JSON under `Artifacts/`.
It returns exit code 1 for a reproduced failure. `--workers` defaults to 20,
`--iterations` to 2,000, and `--timeout` to 180 seconds. The server is for a local
simulator; this runner does not install on physical devices.

## Chromium control

Uses Playwright from the repository's existing wasmer-sh dependencies:

```sh
npm --prefix wasmer-sh ci
node swift/Examples/WebKitMemoryProbe/browser.mjs
node swift/Examples/WebKitMemoryProbe/browser.mjs --mode local
```

Install Playwright's Chromium if it is not already present. The browser runner
uses the same assets, options and result format, with a 180-second deadline.

## Interpretation

On the iOS 27 simulator (24A434), shared mode with 20 receivers failed after
53–54 allocations; local mode completed 2,000. Adding a 10 ms delay still failed
after 52. Counts vary with garbage-collection timing. With only one receiver
and no additional baseline memories, iOS completed 2,000.

`--recycle-every 20` replaces the receiver workers after every 20 acknowledgments.
Both iOS and Chromium completed 2,000 shared-memory allocations with this option.
It is safe for these empty receivers; applying it to the SDK would first require
proving that a retired worker owns no live WASIX tasks.

Chromium 151 also reproduces allocation failure in this deliberately rapid
test; this is not a claim that only WebKit has reclamation limits. The full
browser terminal stress test passes, while the full iOS test still fails.
The probe isolates allocation pressure from application ownership and package
manager behavior; it does not establish the exact engine-internal defect.

See the [investigation report](../../../docs/ios-webkit-memory.md) for memory
maps, the SDK retention fix, controls, and remaining limitations.
