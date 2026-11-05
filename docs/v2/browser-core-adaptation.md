# Browser core adaptation

Source proposal and unvalidated internal implementation; public wrapper integration
and browser acceptance are pending. SDK base
`c352b08566e1564362c747758e3fe440e9d01a33`; runtime base
`0b7d232d9506f5e09e1bc8d55159acb9714fb5da`.

Keep the current JavaScript wrappers at their existing `*Core` seam, replacing
browser execution with a v2-only binding graph, one private Machine per launched
process tree, and shared live WebFs directory owners. One bounded SDK driver on
existing B2 reserved service capacity multiplexes asynchronous operations; root
entries only enqueue/control work, and a state-neutral completion event forwards
owned results to the page without changing worker admission state.

## Existing seams

- SDK `js/src/index.ts`: `Wasmer.initializeCore`, `*Core` handles, stream/capture
  wrappers, terminal dimensions, package progress and service-worker framing.
- SDK `js/bindgen/src/lib.rs`: existing names and argument/result contracts;
  `rust/src/{process,package/definition,fs}.rs`: policies to retain.
- SDK `js/scripts/build-wasm.mjs`: build/assets, replaced browser build only.
- Runtime `lib/wasixv2/host/src/browser/{mod.rs,scheduler.rs}`:
  `BrowserExecutor::services`, `try_spawn_local`, worker-local `block_on` driver.
- Runtime `host/src/browser/{bridge.js,worker.js,coordinator.js}`:
  existing entries, admissions and worker-to-coordinator messages.
- Runtime `api/src/browser.rs`: Machine builder, Run/spawn/wait/kill.
- Runtime `stdio-web/{src/lib.rs,web-streams.mjs}`: bounded live I/O.
- Runtime `api/src/directory.rs`, `vfs-web`: same-provider mount identity and VFS.

## Planned source shape

Add `js/v2-bindgen` as a standalone Cargo graph: no dependency on the existing
v1 SDK Rust crate. Start with retained raw module bytes/WAT and local package
definitions; preserve the existing acquisition algorithms at a later byte
boundary, without loading a second runtime kernel. This staged browser build is
not full SDK parity and does not replace Node/native before their adapters pass.

The root owns only a client queue handle and counters. Its synchronous exports
accept ordinary owned records/bytes, submit work, and return admission status;
they do not `block_on` waits, provider calls, filesystem operations, or process
lifetime. All resource maps and engine objects belong to the service driver.
Raw bytes are compiled on that owner; guest admissions transfer engine objects
through B2's existing envelope hooks. Later opaque Module handling must explicitly
preserve engine-object envelope ownership; it cannot pass a worker-local JsValue
through the shared Rust heap.

The service driver's admitted ThreadStart drives its queue plus existing local
futures, retaining its busy/admission state until close and operation cleanup
finish. Operations snapshot/clone an owned resource before awaiting, never hold a
map lock or mutable state borrow across await. A wait/read does not serialize
unrelated writes, cancellation, filesystem work or another process's operations.
Per-stream read/write lanes permit one in-flight operation each; repeated waits
share the same retained completion, without creating workers per waiter.

Bound both pending operation count and queued transport bytes. Byte transfers
larger than a bounded frame are streamed with backpressure into owned package/
file/input resources; queue bounds must not become a new public maximum module
or file size. Control/cancellation/close must retain capacity when data is full.
Use separate control/data queues or reserved control admission and a bounded
per-poll data budget so a producer cannot starve kill, output or a sibling.

Add one generic `event` forwarding arm to B2's coordinator and an emitter in its
existing browser bridge. The arm forwards an owned structured-clone value and
does not touch status, admission leases, object envelopes, idle or retirement.
SDK completion records carry client generation and operation identity. A fatal
coordinator failure rejects every outstanding operation exactly once, aborts JS
streams, and permanently closes that heap; stale/duplicate events cannot settle
a new generation's requests.

Close refuses new data, cancels outstanding acquisitions/operations, genuinely
stops each Machine, drains or explicitly cancels I/O according to the existing
public operation, releases owned handles, and lets the SDK service ThreadStart
return. Only after admissions and workers are idle does normal B2 shutdown run.
Infrastructure failure discards the heap through B2's failure path, not a success
exit record. `Run::wait` success still requires descendant shutdown, Session
finish, and both output EOFs before SDK completion.

## Open contracts retained

Classic `runWasix(WebAssembly.Module)` accepts an arbitrary opaque Module
directly (`classic/src/run.rs`). No provenance check, recompilation requirement
or input rejection is introduced. Classic Instance exposes wait/streams, while
current SDK kill signals SIGKILL and on wasm explicitly publishes exit 137
before the worker necessarily unwinds (`ProcessControl::force_exit`). V2 genuine
completion may wait forever for a busy opaque module without preemption points;
its actual isolation/kill solution remains mandatory and unresolved by the raw
byte stage. Never report fabricated completion.

All current/classic acquisition/cache, mounts, sibling isolation, TTY, WISP,
service-worker/Ports, Node and native surfaces remain required work. Windows,
snapshots and RTLD_NEXT remain deferred. Native NAPI activation is independently
blocked and is not a prerequisite for the plain WASI browser stage.

## Review and acceptance

The internal raw source currently admits up to 128 data operations, 32 ordinary
controls, one coalesced kill per live-Machine budget slot, and one independent
close. Each queued data/metadata frame is at most 64 KiB; larger module, launch
configuration and diagnostic contents use owned buffers and chunked transfers.
Default live-Machine budget is eight, with the same `1 + 2*M` service limit in
Rust and B2. Each launch has a provisional owner before its first await; close
cancels/drains those owners as well as published processes. Only owned service
tokens retain idle-fence state; historical task-worker IDs are not retained.

This source is inactive and has not passed the compiler or browser gates. The
first independent review found stream chunk sizing, control saturation,
provisional-launch close and error-cleanup defects; the source fixes require
independent delta review and real acceptance before claiming those behaviors.

Root agreed to the bounded service-driver/state-neutral event direction.
Independent design review must approve the exact queue ownership, capacity,
cancellation and close implementation before the larger mechanism lands; an
independent code review follows. No compiler or browser run is authorized until
the serialized validation slot is granted.

Existing test siblings: SDK `js/tests/{runtime,package-definition,
browser-package-definition,worker-failure,client-lifetime,terminal-resize}.test.mjs`;
classic `tests/{run,integration,directory}.test.ts`; runtime browser adapter and
coordinator tests. New acceptance must exercise actual public wrappers against
source-built, version-matched B2 assets with JSPI absent, including full queues,
cancel blocked input/output, repeated waits, sibling kill, held-inode mounts,
close/fatal races and zero-worker disposal. Model passes are not browser proof.
