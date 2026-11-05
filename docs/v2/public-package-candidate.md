# Package/public Core source candidate

This candidate is source only in RAM. The validated internal raw browser slice
and the SDK's default backend remain unchanged. The runtime patch is based on
published `25e60218af5d165727f7cdb06439fd61464ef8e4`; it must land and receive a
new published pin before this candidate's package installer can build.

The package adapter keeps acquisition outside the runtime. It accepts existing
WEBC v2/v3 bytes with supplied alias dependencies and in-memory definitions,
retains original source ownership for cross-client package reuse, and installs
all root/command layers before nonroot mounts on a new private Machine. Shared
Directory owners remain live identities. No legacy runtime is linked.

## Approved facade seams

`browser::spawn_file` uses the existing profile check, task admission, PID,
Running guard, worker dispatch, console completion and Run handle. It calls
`exec_file` on that same task; file/script/loader failures belong to VFS exec.

`install_package_sources` is the single collector used by both mixed sources
and existing `install_packages`. It preserves dependency DFS/pointer dedup,
first command/defaults, reversed root precedence and depth-sorted nonroot
mounts. Memory roots preserve their Arc identity. Existing partial failure
behavior remains; this is not an atomic rollback API.

## Lifecycle seams awaiting agreement

Before the first package-install await, register a provisional launch marker
that owns the Session and cancellation/done state. The operation retains an
unpublished mutable Machine while preparing root/command layers. Close aborts
the Session, marks cancellation and waits for the marker. There is no guest
task yet to signal. Recheck cancellation before promoting the Machine to the
existing Arc-backed launch owner and before/after every subsequent awaited
mount/start boundary. This retains the existing capacity reservation and
cleanup custody without creating an early Signaller or extra Arc that prevents
mutable assembly.

Current public SDK `rust/src/process.rs::wait` waits for the task and snapshots
bounded retained output; it does not consume an unread live pipe. Existing
`command.rs::guest_output_file` and `stream.rs::RetainedOutput` preserve that
output while backpressuring pipe writes. In contrast the internal raw helper
deliberately waits for Session.finish and JS outputDrained. Preserve both
contracts: add a Session producer-seal operation (cancel input, close output
producers without discarding queued bytes); the public lifecycle seals only
after real Run completion, descendant shutdown and console completion, then
publishes the retained result. Unread pipe bytes stay available until read or
owner cancellation. Internal raw wait continues its genuine EOF/drain boundary.
Normal owner close continues explicit AbortError stream cancellation after
real Rust cleanup, rather than claiming canceled output reached EOF.

## Required acceptance discriminators

- Load actual v2/v3 archives and raw bytes; reuse a package after origin close
  in another client; synchronous binary() returns independent owned bytes.
- Mixed memory/archive duplicate commands, root precedence and nonroot mounts;
  shared workspace writes remain visible across sibling private Machines.
- Real VFS command exec, `/proc/self/exe`, script interpreter and kill/close.
- Public pipe wait returns its real retained result with small unread outputs,
  then those outputs remain readable; internal raw wait still requires drain.
- Cancel/close during provisional root installation and during task start;
  no Machine starts after cleanup and reservations follow actual worker idle.

The RAM fixture producer follows existing facade WEBC-writer helpers and uses
the existing SDK hello.wasm. Its source is uncompiled and no fixture artifacts
have been generated. WEBC migration rewrites v2 filesystem mappings, so its
v2 volume is flattened to keep `/data/value` equivalent while v3 tests the
separate `sub` mount root. Heavy validation remains compiler-owner scheduled.
