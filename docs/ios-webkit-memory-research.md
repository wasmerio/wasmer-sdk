# Shared Wasm memory: receiver collection and reservation pressure

Follow-up investigation, September 18, 2026. The [original report](ios-webkit-memory.md)
contains the failing WasmerShell stack, memory map, dispatcher fix, and full
application stress results. **The full iOS failure remains unresolved.** This
follow-up changes the diagnostic probe only, not the SDK runtime.

The new evidence isolates a reclamation problem across worker heaps: collecting
the allocating worker is insufficient, while collecting receiving workers
restores allocation without terminating them. It also identifies an apparent
WebKit accounting gap worth testing in a patched engine. These are different
confidence levels: receiver collection was tested; the specific engine fix was not.

## Direct collection experiment

The [collection probe](../swift/Examples/WebKitMemoryProbe/README.md) sends each
new shared memory to one of twenty workers. It retains only `WeakRef`s to the
producer's memory wrapper and receivers' memory and buffer wrappers. Receivers
acknowledge each message and finish their handlers. At failure it inspects the
wrappers, yields to a new task, collects the producer, and retries. It then asks
receivers to collect through separate control messages, yields again, collects
the producer again, and retries.

Chromium runs with diagnostic `--js-flags=--expose-gc`. WKWebView exposes no such
web API; the iOS diagnostic instead allocates 128 temporary arrays of about
1 MiB each, retaining only the current array, then releases it. That creates
collection pressure, not a guaranteed full collection. Neither technique is
included in the SDK.

| Observation | Chromium 151 / V8 15.1.206.8 | iOS 27 / WebKit 8625.1.29.10.29 |
| --- | ---: | ---: |
| Allocations completed before failure | 124 | 53 |
| Receiver memory wrappers still alive | 124 | 33 |
| Receiver buffer wrappers still alive | 124 | 33 |
| Producer wrappers after producer collection/pressure | 1 | 0 |
| Retry after producer collection/pressure | Fails | Fails |
| Receiver memory and buffer wrappers after receiver collection/pressure | 0 each | 7 each |
| Retry after receiver collection/pressure | Succeeds | Succeeds |

In Chromium, collecting the producer after **every allocation** still fails
after 123 allocations. Collecting the receiving worker after **every
acknowledgment** completes **2,000/2,000**. An earlier iOS repeat also recovered,
with receiver wrappers dropping from 32 to 8. Counts vary with collection timing.

This is stronger evidence than the earlier worker-replacement experiment:
receiver collection itself can release enough backing reservations. It does
not prove that every SDK memory holder has the same lifetime. Weak-reference
counts are JavaScript wrapper counts, not a general count of distinct native
reservations. The probe yields between inspection and collection because
`WeakRef.deref()` temporarily keeps its result alive for the current job.

## Why relatively small memories can exhaust WebKit

The captured app failure had an approximately 826 MiB physical footprint and
a nearly full 16 GiB virtual buffer region. The SDK's own linear heap was only
about 308 MiB. A reservation uses address space independently of how much of
its memory has been touched.

The inspected upstream WebKit source explains this geometry:

- iOS has a 16 GiB primitive address-space budget in
  [Gigacage.h](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/bmalloc/bmalloc/Gigacage.h#L58).
- Each fast wasm32 memory reserves 4 GiB plus a guard region in
  [BufferMemoryHandle.cpp](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/runtime/BufferMemoryHandle.cpp#L57).
  The [defaults](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/runtime/OptionsList.h#L595)
  allow three fast memories on iOS, with 8 MiB guards. Those three alone occupy
  slightly more than 12 GiB. Subsequent bounds-checked shared memories reserve
  space for their maximum size: 128 MiB in our baseline.
- Allocation pressure invokes collection on the **calling VM**, then retries,
  in [WasmMemory.cpp](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/wasm/WasmMemory.cpp#L74).
  That does not collect every worker heap that might own a shared backing.

Thus a process-wide reservation budget can fill while each receiver has too
little local allocation pressure to collect promptly. Three fast reservations
plus roughly thirty 128 MiB reservations fit the observed failure geometry;
this is an explanation, not a guaranteed memory-count limit.

These source links are pinned to upstream WebKit revision
`7ed302f504e22a82977a3ef7301b6580c5ba92a4`. It is not a verified source match for
Apple's simulator binary. The memory-map measurements and experiments are
independent of that source-version assumption.

## Size, receiver, and visibility controls

All rows use the iOS 27 simulator and 2,000 requested allocations. Each memory
goes to one receiver; these tests do not broadcast it to the entire pool.

| Configuration | Result |
| --- | --- |
| 20 receivers, initial 8.3125 MiB, maximum 128 MiB | Fails after 53–54 |
| Same allocations, memory kept in producer | 2,000 pass (previous run) |
| 20 receivers, initial **64 KiB**, same 128 MiB maximum | Fails after 33 |
| 20 receivers, same 8.3125 MiB initial, maximum **32 MiB** | 2,000 pass |
| 4 receivers, baseline memory sizes | 2,000 pass |
| 1 receiver, baseline sizes, touches `.buffer` | 2,000 pass (previous run) |
| 1 receiver, baseline sizes, **does not access `.buffer`** | Fails after 33 |
| 20 receivers, baseline sizes, WKWebView **visible and attached** | Fails after 54 |

The tiny-initial-size test fails despite its 33 requested initial memory sizes
totaling only about 2.06 MiB. That number excludes engine overhead and is not
a process-footprint measurement. Lowering the maximum reduces reservation
pressure and allows more time for collection; it is not a validated SDK fix
and would restrict guests' ability to grow. Visibility is not required for
failure; this does not establish that visibility never affects collection
scheduling.

## Candidate WebKit accounting gap

The [shared-memory deserializer](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/runtime/CloneDeserializerBase.h#L730)
creates a `JSWebAssemblyMemory` wrapper, then adopts a native memory sharing
the existing backing. In
[JSWebAssemblyMemory.cpp](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/wasm/js/JSWebAssemblyMemory.cpp#L43),
creation starts with an empty placeholder and `finishCreation()` reports its
size to the heap **before adoption**. `adopt()` swaps the memory without
reporting the newly adopted size. Growth reports a delta, and visiting the
wrapper reports its size during collection, but neither necessarily triggers
timely collection after initial adoption.

Accessing `.buffer` creates another wrapper. Its
[JSArrayBuffer initialization](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/runtime/JSArrayBuffer.cpp#L45)
calls [Heap::addReference](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/heap/Heap.cpp#L768),
which accounts for the buffer's
[current byte length](https://github.com/WebKit/WebKit/blob/7ed302f504e22a82977a3ef7301b6580c5ba92a4/Source/JavaScriptCore/runtime/ArrayBuffer.h#L379).
This provides a plausible explanation for the large difference between the
one-receiver buffer-access and ignore controls. Even that accounting describes
current bytes, not the much larger reserved address range.

**This is a source-level candidate, not a verified patch.** Validation requires
an engine build that accounts for adoption and reruns both buffer-access modes.
The SDK already accesses `.buffer` while validating imported memories, so the
ignore-buffer result alone does not explain the full SDK failure.

Chromium also reproduces the cross-worker collection problem. Its installed
V8 version's [backing-store allocator](https://github.com/v8/v8/blob/15.1.206.8/src/objects/backing-store.cc)
uses an 8 GiB guarded reservation for wasm32 memories and retries allocation
through the calling isolate's collection path. There is an important accounting
nuance: [ordinary shared-buffer accounting](https://github.com/v8/v8/blob/15.1.206.8/src/objects/backing-store.h#L181)
returns zero, but [Wasm memory deserialization](https://github.com/v8/v8/blob/15.1.206.8/src/objects/value-serializer.cc#L2520)
explicitly supplies `byte_length()` to managed-object accounting. Therefore
“V8 does not account for shared Wasm memory” is not an accurate conclusion.
The direct collection experiments establish the behavior without relying on
that interpretation.

## How the SDK amplifies the allocation pattern

At the pinned runtime revision, every task envelope includes
[all live local modules and shared memories](https://github.com/wasmerio/wasmer/blob/195137ff236201ba701a1fe9184f79d14d6d27ab/lib/api/src/backend/js/utils/shared_handle.rs#L137).
It does not select only objects required by that task or omit IDs already sent
to that receiver. Browser structured cloning therefore creates wrappers even
when the receiver's registry already has that object. It can also distribute
guest memories to workers that never execute the guest.

Dropping an expired Rust registry entry releases an application handle; it
does not force the engine to collect unreachable wrappers. The dispatcher
retention fix removes one source of strong references, but cannot guarantee
when other heaps collect.

The next SDK experiments should reduce redundant cloning with per-connection
deltas or task-specific object transport, and bound the lifetime of workers
after all their tasks finish. The latter needs stronger lifecycle accounting:
[`active_blocking_jobs`](../js/bindgen/src/tasks/thread_pool_worker.rs) controls
`MarkIdle`, but asynchronous thunks do not increment it. The existing idle
signal alone is not proof that terminating a worker is safe.

## Related upstream reports

[WebKit 269937](https://bugs.webkit.org/show_bug.cgi?id=269937) discusses
unpredictable Wasm allocation and Gigacage pressure. It was closed as a
duplicate after the 2024 cage-size changes, with a request for new reports if
the problem persisted. It is useful context, not confirmation of our exact bug.

[WebKit 281657](https://bugs.webkit.org/show_bug.cgi?id=281657) concerns leaked
shared Wasm memory across page reloads. Its
[landed fix](https://github.com/WebKit/WebKit/pull/35780) repairs worker
termination while waiting in Wasm atomics. Our reproduction instantiates no
Wasm code and never calls `Atomics.wait`; that specific fix does not explain
this reproduction. No published fix was verified for our current failure.

## Reproducibility and remaining limits

The [probe README](../swift/Examples/WebKitMemoryProbe/README.md) documents the
commands and collection controls. [Captured results](ios-webkit-memory-research-results.json)
include browser/OS versions and actual WebView attachment state. The hidden
and visible iOS controls ran in a dedicated simulator, preserving WasmerShell's
session on the user's simulator. Physical iPhone execution remains untested.

This investigation does not clear the previous clean full iOS failure at
39/175 checks. Chromium's full terminal stress run remains passing, while the
concentrated engine-only probe demonstrates a related reclamation limit there.
An upstream engine patch and an SDK transport/lifecycle mitigation both need
validation against the full workload, with diagnostic GC pressure removed.
