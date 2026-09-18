# WebKit memory investigation

Investigated on September 18, 2026, using the iPhone 18 Pro simulator,
iOS 27.0 (24A434), WebKit 8625.1.29.10.29. The execution WKWebView was
unattached. The SDK heap limit remained 512 MiB and the shared guest-memory
limit remained 128 MiB.

**The long-session iOS failure remains unresolved.** We fixed an independently
verified dispatcher retention bug, but a clean full iOS run still failed after
39 of 175 checks. An engine-only reproduction now triggers the same allocation
error without Wasmer or any package manager. The evidence points to delayed
reclamation of shared-memory reservations across worker heaps.

## Failing allocation

The failure is reproducible after repeated package installs, but the number
of subsequent Python launches varies with allocation and collection timing.
A control run completed all eleven uncached Flask/Django/FastAPI installs
and 31 subsequent Python launches. The next launch failed with
`RangeError: Out of memory` (54 of 175 checks completed).

Logging only the generated SDK's exception handler captured this call path:

```text
WebAssembly.Memory constructor
Memory::js_memory_from_type
proc_fork's memory-copy callback
Function::call
ContextSwitchingEnvironment::run_main_context
```

Bash could not allocate its child's memory before Python started. The SDK
heap was 328,400,896 bytes (313.2 MiB), below its 512 MiB limit. This particular
failure was not a JSPI stack allocation: the instrumented Python/Bash workload
used the synchronous/Asyncify path.

## Address-space pressure

A separate failure-only probe captured the allocation descriptor and paused
the failing worker long enough to inspect its process with `vmmap`:

| Measurement | At the captured failure |
| --- | --- |
| SDK heap | 322,633,728 bytes (307.7 MiB) |
| Fork memory initial size | 133 Wasm pages (8.3125 MiB) |
| Effective guest maximum | 2,048 pages (128 MiB), applied by the iOS policy |
| WebKit physical footprint | 825.8 MiB; peak 1.7 GiB |
| Buffer region | 16 GiB, at `0x7000000000`–`0x7400000000` |
| Remaining unallocated tail in that region | About 15.7 MiB |

The region contained three roughly 4 GiB mappings and many 128 MiB guest
reservations. Those reservations occupy address space even when their pages
are not resident. WebKit's buffer allocator uses a bounded Gigacage region;
its fast Wasm memories reserve the wasm32 address range plus a guard area.
See [WebKit's buffer-memory allocator](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/BufferMemoryHandle.cpp)
and [Wasm memory allocation](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/wasm/WasmMemory.cpp).
The exact region size above is an observation from this simulator, not a
portable memory guarantee.

The allocation failure path in the inspected WebKit source collects the
**calling VM's** heap before retrying. Shared-memory wrappers in other workers
belong to other heaps. The inference from the source, memory map, and controls
below is that their delayed collection can keep backing reservations alive
while the allocating worker cannot reclaim them. The exact internal retention
path has not been proven with an engine heap trace. The inspected upstream
source is also not a symbol-for-symbol match for Apple's shipped binary.

At failure, explicitly collecting the calling worker's expired Rust shared
handles reduced its registry from two entries to one, with no live shared
memories remaining in that registry. Retrying immediately still failed.
A diagnostic retry after a 60-second idle period succeeded, and another
allocation subsequently failed. This demonstrates sensitivity to reclamation
timing; no delay or artificial allocation-pressure workaround is shipped.

## Dispatcher retention

The browser dispatcher awaited `worker.handle(data)`. Its suspended JavaScript
frame therefore kept `data` alive until the task completed. That transport
envelope includes shared modules and guest memories, not just the task pointer.
A long-lived background task could retain memories it did not need, even after
Rust dropped the corresponding ownership handles.

The dispatcher now returns the task promise directly. Rust consumes the
envelope while dispatching the task, and owns the references it actually needs.
The JavaScript dispatch frame can disappear while the task remains pending.
The existing outer rejection handler still reports task failures.

The regression exercises the real browser dispatcher with a mock Rust
entrypoint. It sends sixteen memory-bearing envelopes, half before worker
initialization, and keeps all task promises pending. Before the fix all sixteen
memories remain reachable after garbage collection; after the fix none do.
It also checks that a later task rejection is still reported.

This fix does **not** eliminate the iOS OOM. The subsequent clean production
run completed eleven pip installs and sixteen Python launches, then failed on
the next launch (39 of 175 checks). No diagnostic allocation wrappers or retry
delays were present in that validation run.

## Engine-only reproduction

[`WebKitMemoryProbe`](../swift/Examples/WebKitMemoryProbe/README.md) is a small
Swift app plus three web assets. Its WKWebView remains unattached. A producer
creates shared `WebAssembly.Memory` objects with `{initial: 133, maximum: 2048}`
and sends each to a receiving worker, which touches one byte and acknowledges
it. No module is instantiated and neither side keeps a collection of memories.
There is no SDK, Rust, Python, pip, Asyncify, or JSPI in this reproduction.

The local control performs the same allocations and worker acknowledgments
without including memory in the messages. Results on the same simulator:

| Probe configuration | Completed allocations |
| --- | ---: |
| 20 receivers, memory sent to receivers | 53–54, then OOM |
| 20 receivers, memory stays in producer | 2,000 / 2,000 |
| 20 receivers, shared, 10 ms pause between allocations | 52, then OOM |
| 1 receiver, shared, no baseline memories | 2,000 / 2,000 |
| 20 receivers, shared, replace idle receivers every 20 allocations | 2,000 / 2,000 |

An earlier variant also held an SDK-sized shared memory and a Bash-sized
baseline memory. That failed after 51 allocations with 20 receivers and 34
with one receiver; its no-transfer control completed 2,000. Artificially
allocating temporary arrays in receiving workers delayed failure to 1,050
allocations but did not eliminate it. These are diagnostic variations, not
proposed production solutions. Counts are timing-dependent, not fixed limits.

Chromium 151.0.7922.34 also failed in the rapid shared-memory probe (124
allocations with twenty receivers; 123 with a 10 ms pause; 247 with one receiver).
Its local control completed 2,000. This mechanism is therefore not demonstrated
to be exclusive to WebKit. The full application workload currently fails on
iOS and passes in Chromium; the standalone test intentionally concentrates
the allocation pattern and does not model normal command pacing.

Replacing all twenty receiver workers after every twenty acknowledgments lets
both iOS and Chromium complete 2,000 shared-memory allocations. The receivers
in this probe have no outstanding work at that point. This is a concrete
lifecycle mitigation in the reproduction, not yet a safe SDK implementation.
Captured results are in [the result data](ios-webkit-memory-results.json).

The result separates application ownership bugs from an engine reclamation
limitation. JavaScript has no portable explicit collection or memory-disposal
operation that would make this allocation pattern deterministic. The next SDK
step is to establish when workers are genuinely idle and can be retired, and
reduce the number of realms that receive each guest memory. These require lifecycle
changes: terminating a worker that still owns a WASIX task would break the
session. Increasing the SDK heap cap does not address the measured reservation
pressure.

## Reproduction and validation

```sh
npm --prefix js run build:ts
node --test js/tests/worker-message-lifetime.test.mjs
npm --prefix wasmer-sh run test:stress
python3 swift/Examples/WasmerShell/build.py stress --device <IOS_27_SIMULATOR_UDID>
python3 swift/Examples/WebKitMemoryProbe/run.py --device <IOS_27_SIMULATOR_UDID>
python3 swift/Examples/WebKitMemoryProbe/run.py --device <IOS_27_SIMULATOR_UDID> --mode local
```

The dispatcher regression, five worker/filesystem tests, and two browser
worker/Python tests pass. Chromium's full 45-check terminal stress run passes,
with a final SDK heap of 360,579,072 bytes (343.9 MiB). The full iOS run fails as
described above. Earlier passing quick/integration runs do not clear that
failure.

The full iOS test now includes 150 keyboard-driven Python launches after the
eleven package installs, then output pressure and restart with pending input.
Use a dedicated simulator: the test intentionally reinstalls packages in its
Documents directory. Broad diagnostic wrappers changed the reproduction
timing and sometimes made the old code pass, so production validation must
run without them. Physical-iPhone behavior requires separate device testing.
