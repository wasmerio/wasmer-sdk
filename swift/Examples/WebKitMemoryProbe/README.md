# WebKit shared Wasm memory probe

An engine-only reproduction of shared WebAssembly memory allocation failure.
It creates no Wasm module and loads no Wasmer SDK, Rust, WASIX, Python, or JSPI.
The iOS app runs its WKWebView unattached by default, and displays diagnostic text.

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
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --initial 1
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --maximum 512
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --workers 1 --receiver-access ignore
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --visible
```

The script builds a small Swift app, serves the JavaScript over host loopback
with COOP/COEP headers, waits for its result, and saves JSON under `Artifacts/`.
It returns exit code 1 for a reproduced failure. `--workers` defaults to 20,
`--iterations` to 2,000, and `--timeout` to 180 seconds. The server is for a local
simulator; this runner does not install on physical devices.

`--initial` and `--maximum` are in 64 KiB Wasm pages (defaults: 133 and 2,048).
`--receiver-access ignore` skips reading `.buffer` in the receiver; the default
is `buffer`. `--visible` attaches the WKWebView as a visibility control and
records its actual attachment state. These flags affect only this probe app.

## Chromium control

Uses Playwright from the repository's existing wasmer-sh dependencies:

```sh
npm --prefix wasmer-sh ci
node swift/Examples/WebKitMemoryProbe/browser.mjs
node swift/Examples/WebKitMemoryProbe/browser.mjs --mode local
```

Install Playwright's Chromium if it is not already present. The browser runner
uses the same assets, options and result format, with a 180-second deadline.
The `--visible` option is specific to the iOS runner.

## Collection experiment

The collection probe tracks memory and buffer wrappers through weak references.
It first allocates until failure or the requested iteration count. It then
counts remaining wrappers, collects the producer and retries, collects the
receivers and retries. Inspections and collections occur in separate tasks so
`WeakRef.deref()` does not keep an object alive during a subsequent collection.

```sh
node swift/Examples/WebKitMemoryProbe/browser.mjs --probe collection
node swift/Examples/WebKitMemoryProbe/browser.mjs --probe collection --gc-mode producer
node swift/Examples/WebKitMemoryProbe/browser.mjs --probe collection --gc-mode receivers
python3 swift/Examples/WebKitMemoryProbe/run.py --device <UDID> --probe collection
```

Chromium enables diagnostic `--js-flags=--expose-gc` only for this probe. iOS
instead creates temporary JavaScript allocation pressure: it allocates about
128 MiB in total, retaining only the current approximately 1 MiB array, then
releases it. This cannot guarantee a full WebKit collection. Neither technique
is an SDK fix or a supported production memory-management API.

`--gc-mode none` (default) adds no collection during the allocation loop;
`producer` collects the producer after every acknowledgment; `receivers`
collects the receiver through a separate message after every acknowledgment.
All modes also perform the final producer/receiver recovery experiment.
`--workers` and `--iterations` apply. The collection probe always uses shared
memories with initial 133 and maximum 2,048 pages; allocation-probe tuning flags
(`--mode`, size, receiver access, delay and recycling) do not apply.

Exit code 1 means the allocation loop failed, **even if a later diagnostic
retry succeeds**. Inspect `retryAfterProducerCollection` and
`retryAfterReceiverCollection` to distinguish those outcomes.

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

The collection probe provides stronger evidence: Chromium fails after 124
allocations, keeps all 124 receiver wrappers alive after producer collection,
then reclaims them and successfully retries after receiver collection.
Per-receiver collection allows 2,000 allocations; per-producer collection still
fails. iOS allocation pressure reduces receiver wrappers from 33 to 7 and also
restores allocation. A visible WKWebView still fails after 54 allocations.

See the [investigation report](../../../docs/ios-webkit-memory.md) for memory
maps, the SDK retention fix, controls, and remaining limitations.
The [follow-up research](../../../docs/ios-webkit-memory-research.md) adds the
collection results, size/visibility controls, and pinned engine-source analysis.
