# Code Review — Unofficial NAPI Surface Reduction

**PRs under review:**

| Repo | PR | Branch | Head | Base (merge-base) | Size |
|---|---|---|---|---|---|
| [wasmerio/napi](https://github.com/wasmerio/napi/pull/59) | #59 | `codex/napi-surface-reduction` | `6a6e2d0` | `2a559e7` (main) | +3,414 / −5,556, 37 files |
| [wasmerio/edgejs](https://github.com/wasmerio/edgejs/pull/147) | #147 | `codex/napi-surface-reduction` | `026d783d` | `1ca99ab` (main) | +1,458 / −875, 36 files |

edgejs #147 depends on napi #59 (napi is vendored into edgejs as the `napi` submodule).

**Review date:** 2026-08-13 · **Re-review round 2:** napi `14a6c01` / edgejs `b1aa104e` · **Re-review round 3:** napi `ad55ac0` / edgejs `fc5f7262` — see [Round 3](#re-review-round-3) for current status.
**Method:** 11 independent finder angles (5 correctness, 3 cleanup, altitude, conventions, split line-by-line scans per PR) → 46 raw candidates → deduplicated to 28 → 17 adversarial verifier agents (CONFIRMED / PLAUSIBLE / REFUTED, with quoted evidence; one finding reproduced by running the actual test binary) → final gap-sweep pass with the verified list.

---

## Re-review — fix verification

The follow-up commits (napi: `7ea3f68`, `9cd1ee0`, `d8bc023`, `14a6c01`; edgejs: `b1aa104e`, submodule bumped to `14a6c01`) were verified by 5 agents: one per fix area re-reading the new code at HEAD, plus a fresh-eyes sweep of the full ~3,500-line fix delta. Where binaries existed, fixes were verified empirically: the previously-aborting `napi_v8_test_21_general` now passes 13/13 as a single process; the new MessagePort regression test **fails on the pre-fix binary** and passes on the rebuilt one; a 4 MB / 200-pause HTTP/2 flow-control run delivered byte-exact data.

### Outcomes — main findings

| # | Finding | Outcome |
|---|---|---|
| 1 | Engine-flags process abort | **Fixed** — flags applied once inside first-runtime init (defaults → user flags → `Initialize`); identical flags idempotent, conflicting flags → clean `napi_invalid_arg`; new regression test |
| 2 | MessagePort+ArrayBuffer silent drop | **Fixed** — new `CloneMessageValueWithArrayBufferTransfers` transfers only ArrayBuffers; markers survive to delivery; regression test pins the exact trigger |
| 3 | Submodule pin behind | **Fixed** — gitlink now `14a6c01`, exactly the napi head |
| 4 | wasmer.toml personal namespace | **Skipped** — still `syrusakbary/edgejs` 0.1.14; revert (or confirm intentional) before merge |
| 5 | Heap-snapshot JSON in-isolate | **Fixed** — external UTF-8 bytes contract (Uint8Array over host malloc memory); no in-heap allocation, no kMaxLength cap |
| 6 | Non-index property enumeration | **Fixed** — engine-level `get_own_non_index_properties` restored across header, both providers, JS host, and wasm bridge; edgejs is one call again (but see new finding N1) |
| 7 | profile_stop consumes handle early | **Fixed** — non-destructive `Load`, `Take` only when the provider consumed the session; retry pinned by new test |
| 8 | Tick trampoline reads mutable Reflect | **Fixed** — intrinsic captured at setup; ref installed only after full success; regression test. Residual: dispatch still reads `globalThis.process` per tick for a receiver the closure ignores — deletable |
| 9 | consume() swallows ReadStart failure | **Fixed** — throws uv error / `ERR_HTTP_PARSER_CONSUME`; rollback verified consistent (no dedicated test, though) |
| 10 | QuickJS CallSite strict-mode censoring | **Skipped** — submodule pin unchanged; the capability leak remains |
| 11 | JS-host bytecode shape bypass | **Fixed** — shape stored per entry, all three consumers validate, error code matches native |
| 12 | Invalid cache pointer → cache miss | **Fixed** — shared decoder propagates the read failure as `napi_invalid_arg`; empty-cache-is-a-miss pinned by test |
| 13 | QuickJS `guest_heap_ctx` never released | **Fixed** — released exactly once at entry, weak no-op fallback for native links (but see new finding N2) |
| 14 | Rejected cachedData wasted compile | **Fixed** — `cache_policy { compile_on_reject, validate_only }` in options v2, implemented identically in both providers; only the vm cachedData path opts into validate-only |
| 15 | Drifted hand-rolled ABI decoders | **Fixed** — new shared `src/guest/abi.rs` used by both bridges, offsets verified field-for-field. Residual: the 52-byte env_create_options prefix is still hand-decoded twice (currently byte-identical) |

### Outcomes — second-tier items

Fixed: **16** (kHeapSpaces empty-array fallback restored), **17** (heap-space snapshot taken once per JS call — but see N3), **19** (`positions_only` metadata mode; the positions caller switched to it), **22** (`IsValidJsSource` deleted), **23** (`napi_bytecode_record_from_source` helper in `napi_bytecode.h`), **24** (`CopyUtf8Bytes` via buffer lease; one string helper remains), **25** (`has_top_level_await` removed from module_state in lockstep across every layer; dead getter deleted), **26** (`was_preserved` removed everywhere; test rewritten to an equivalent observable), **27** (host-side attach set removed; mandatory one-shot added to the JS backend with matching error code), **28** (heap-statistics gained size/version/`valid_fields` mask; providers stopped fabricating — note QuickJS `memoryUsage().arrayBuffers` now honestly reports 0 where it previously mirrored external memory), **29** (single `GetJavascriptHeapMetrics` helper; all nine fields now real, memoryLimit divergence resolved), **30** (both test pins restored — the QuickJS marker checks engine-guarded, the queueDestroyAsyncId drain actually running under the loop), **C3** (`JS_IsObject` guard before the arrowMessage read).

Still open: **18** partial — TLA polling is gone, but `getStatus`/`getError` still materialize the error handle and recompute `IsGraphAsync` per poll (no status-only fast path); **21** — the bytecode_open orchestration is still duplicated verbatim between the two C++ providers (the cache_policy fix grew both copies identically; semantics currently identical, maintenance risk only).

### New findings introduced by the fixes

| # | Location | Defect |
|---|---|---|
| N1 | `packages/napi/v8/src/unofficial_napi.cc:2719` | The restored `get_own_non_index_properties` calls `GetPropertyNames` with **no TryCatch**: a throwing `ownKeys` proxy trap leaves a scheduled-but-unrecorded exception and returns `napi_generic_failure`; `napi_is_exception_pending` then reports false, edgejs throws a fresh DataCloneError over the scheduled exception (user's error lost, corrupted exception state). QuickJS records it properly — provider divergence. Fix: TryCatch + `SetLastException` like the other entry points. |
| N2 | `packages/napi/quickjs/src/unofficial_napi.cc:208` | `guest_heap_ctx` is read (offset ~40) and released **before** the options size/version validation, so an older/smaller options struct is read out of bounds and a garbage pointer handed to the host free hook instead of a clean `napi_invalid_arg`. V8 shares the read-before-validate pattern. Latent; fix both: read the field only when `options->size` covers it. |
| N3 | `packages/edgejs/src/internal_binding/binding_v8.cc:250` | The heap-space snapshot cache refreshes only at index 0 and clears only after the last index, so repeated queries of a fixed middle index serve permanently stale statistics (benign for `lib/v8.js`, which always starts at 0; wrong for direct binding users or aborted iterations). |

### Remaining after round 2

1. **N1** (TryCatch) — the only new must-fix
2. **wasmer.toml** namespace (finding 4) — revert or confirm intentional
3. **CallSite censoring** (finding 10) — vendored-patch fix in quickjs
4. N2/N3, the getStatus fast path (18), and the shared bytecode_open helper (21) — nice-to-have follow-ups

---

## Re-review round 3

Against napi `ad55ac0` (`902011c` "Fix provider boundary validation", `ad55ac0` "Query only requested module state") and edgejs `fc5f7262` ("Harden reduced N-API integration"); the edgejs submodule pin matches the napi head. Verified by one fix-verification agent and one fresh-bug sweep over the ~1,200-line delta.

### Outcomes

| Item | Outcome |
|---|---|
| N1 — get_own_non_index_properties TryCatch | **Fixed** — tightly-scoped TryCatch + `napi_v8_set_last_exception`, semantics identical to QuickJS; pinned by new `PropertyEnumerationPreservesThrownProxyException` test |
| N2 — guest_heap_ctx read before validation | **Fixed** in both providers — size/version validated first, field read only after validation proves it present; header documents the handshake; two regression tests count release-hook invocations |
| N3 — heap-space cache staleness | **Fixed** — cache survives only one contiguous forward walk; any repeat/skip/backwards request re-snapshots |
| 18 remainder — getStatus per-poll materialization | **Fixed** — `get_state` now takes three nullable outs (`status_out`, `error_out`, `has_async_graph_out`), expensive fields computed only when requested; the `module_state` struct is deleted; all layers (header, both providers, `abi.rs`, both bridges, `snapi.rs`, `napi_bridge_init.cc`, edgejs call sites) updated in lockstep — with one stale caller missed, see N5 |
| 8 residual — per-tick `process` lookup | **Fixed** — receiver captured into `tick_receiver_ref` at setup with pairwise ref lifecycle; test hardened with a throwing `process` getter |
| 15 residual — env_create_options decoder duplication | **Fixed** — shared `abi::read_env_create` (52-byte prefix) used by both bridges |
| 4 — wasmer.toml namespace | **Skipped again** — still `syrusakbary/edgejs` 0.1.14 |
| 10 — QuickJS CallSite strict-mode censoring | **Skipped again** — submodule pin unchanged; capability leak remains |
| 21 — bytecode_open duplication | **Skipped again** — both provider copies remain verbatim |
| Header doc — engine-flags contract | **Skipped** — first-init-only behavior still documented only in the V8 .cc |

### New findings (round 3)

| # | Location | Defect |
|---|---|---|
| N4 | `packages/napi/v8/src/unofficial_napi_contextify.cc:1715` | The N1 defect class survives in `make_context`: `SnapshotOwnProperties`/`RestoreOwnProperties` call `GetPropertyNames` with **no TryCatch**, and make_context returns `napi_pending_exception` without recording `env->last_exception` — `vm.createContext(proxySandbox)` with a throwing `ownKeys` trap reproduces the scheduled-but-unrecorded exception state. Same fix as N1. |
| N5 | `packages/napi/tests/programs/run_script_test.c:255` | Stale caller missed by the get_state migration: still uses the deleted `unofficial_napi_module_state` struct and 3-arg signature — the wasm32 guest program behind the imports-lane host-js smoke test **cannot compile**. (Pre-broken before round 3 — it referenced a field the round-2 struct already lacked — so this test lane has been dead for a while.) |
| N6 | `packages/napi/src/snapi_js.rs:4964` | `get_state` inserts the module-error JsValue into the env value registry **before** the `has_async_graph` computation that can fail; on `NAPI_INVALID_ARG` the guest wrapper suppresses output writes, so the inserted id is unreachable — one leaked registry slot per retry. Compute-then-insert. |
| N7 | `packages/napi/v8/src/unofficial_napi.cc:1931` (+ QuickJS twin) | `napi_invalid_arg` from create_env is now **ambiguous about guest_heap_ctx ownership**: null `env_out`/`scope_out` returns before validation without releasing, while the flags failure after validation releases — same status, opposite outcomes; defensive callers either leak or double-release. Release on every post-validation failure including the null-out path, or use distinct statuses. |

### Remaining before merge (current)

1. **N4** — the make_context TryCatch gap (same one-line pattern as the N1 fix)
2. **N5** — port `run_script_test.c` to the new get_state signature (restores a dead test lane)
3. **wasmer.toml** namespace — revert or explicitly confirm intentional
4. **CallSite censoring** (finding 10) — vendored quickjs patch
5. N6, N7, the shared bytecode_open helper (21), and the engine-flags header doc — minor follow-ups

*Note: both working trees carried uncommitted edits beyond the reviewed heads during this round (e.g. `guest_heap_ctx` → `guest_heap` renames). This review covers the pushed heads only.*

---

## Executive summary

The surface reduction itself is **structurally sound**. The full cross-repo trace found zero loose ends: every deleted `unofficial_napi_*` symbol has no surviving caller in either repo, the wasm import tables (66 functions) match the new header exactly, every versioned descriptor layout (env_create_options 52-byte prefix, env_hooks 40 B, bytecode_open_options 48 B, module_create_options 40-byte prefix, js_source 12 B, error_metadata, heap statistics PODs) agrees byte-for-byte between the C header and both Rust guest decoders, and all build wiring (build.rs, CMakeLists, build-test-native.sh, quickjs-wasm/build.sh) is consistent.

That said, the review confirmed **2 merge blockers**, **2 merge-logistics items**, and a set of high/medium findings — plus a second tier of smaller confirmed cleanups. Several scary-looking candidates were **refuted** with code evidence and are documented at the end so nobody re-chases them.

**Fix-first list:**

1. Engine-flags process abort (napi) — reproduced in-tree
2. MessagePort + ArrayBuffer transfer silently drops messages (edgejs)
3. Bump the edgejs `napi` submodule pin to PR 59's head
4. Revert `wasmer.toml` publish namespace

---

## Blockers

### 1. Second env with new `engine_flags` aborts the process — **CONFIRMED (reproduced)**

`packages/napi/v8/src/unofficial_napi.cc:1896-1900`

`unofficial_napi_create_env` now applies per-env `engine_flags` via `v8::V8::SetFlagsFromString` on **every** call. But `AcquireRuntime` calls `V8::Initialize()` exactly once (freezing flags — `freeze_flags_after_init` defaults to true in the pinned V8 11.9.2), and `ReleaseRuntime` deliberately never disposes the runtime. Any later env whose flags **change a value** hits `Check failed: !IsFrozen()` → **V8 FATAL, whole-process abort**, with no way to return an error.

**Reproduced:** running the PR-head test binary `build-napi-v8/v8/tests/napi_v8_test_21_general` as a single process aborts at `NearHeapLimitCallbackUsesOneConfigurationSlot` — the prior test creates an env with `options=nullptr` (flags freeze), the next `EnvScope` passes `--expose-gc --js-float16array`. CI masks this because commit `6a6e2d0` switched to `gtest_discover_tests` (each test case runs in its own process).

The removed `unofficial_napi_set_flags_from_string` was called once before the first env by all in-tree callers, so this abort path is newly reachable.

**Fix:** apply `engine_flags` only inside the first-runtime-init block (before `V8::Initialize`), and return an error / warn-and-no-op when flags are supplied after init. Also note: on the *first* env, user flags are applied **before** `ApplyDefaultV8Flags`, so the defaults (`--js-explicit-resource-management --js-float16array`) silently override user-provided negations — apply defaults first, user flags second.

### 2. MessagePort transferred together with an ArrayBuffer silently drops the message — **CONFIRMED**

`packages/edgejs/src/internal_binding/binding_messaging.cc:3899`

`MessagePortPostMessageCallback`'s queued-delivery (slow) path switched from `CloneMessageValue` to `CloneMessageValueWithTransfers` — but it runs on a payload whose MessagePorts were **already** collected and replaced with `{__ubiMessagePortTransferIndex: N}` placeholders. The helper then:

1. re-collects the same ports from the transfer list (line 2711),
2. detaches them prematurely (line 2764 — the caller's own later detach at 3936 becomes a silent no-op because the handle state is already `kEdgeHandleClosing`),
3. `RestoreTransferredPortsInValue` splices **live sender-realm MessagePort wrappers** into the clone in place of the markers, taking ownership of the port data (`data->attached_port = wrap; data->closed = false`).

`EnqueueMessageToPort` then tries to structured-clone a payload containing a native-wrapped host object; on the V8 backend the serializer has no `WriteHostObject` override, so it throws DataCloneError, which `ClearPendingException` swallows (lines 3430-3436) — **`postMessage` returns `true` and the peer never receives the message** (no `message`, no `messageerror`). The port data is also dually owned by the hidden sender wrapper and the queued transfer entry.

**Trigger:** `port1.postMessage({p: subPort, buf}, [subPort, buf.buffer])` — an ArrayBuffer in the transfer list forces the slow path (`fast_path_peer != nullptr && arraybuffer_transfer_list == nullptr` at 3893). Also reachable for any slow-path post (broadcast/unentangled port) with a transferred port referenced in the payload.

**Test gap:** no test in the tree covers port-in-payload + ArrayBuffer combined transfer (`test-worker-message-port-transfer-target.js` posts a null payload; `test-worker-message-port-message-port-transferring.js` has no ArrayBuffer, so it stays on the fast path).

**Fix:** restore the pre-PR behavior on this path (clone without re-running the port pipeline — ports are already marker-substituted), or make `CloneMessageValueWithTransfers` transfer only the ArrayBuffers and leave port markers untouched.

---

## Merge logistics

### 3. edgejs pins the napi submodule one commit behind PR 59's head — **CONFIRMED**

`packages/edgejs/napi` (gitlink) → `4fda2b3`; napi PR 59 head is `6a6e2d0`. The missing commit is exactly the `gtest_discover_tests DISCOVERY_MODE PRE_TEST` fix, so edgejs CI keeps the transient discovery breakage PR 59 fixes — and merging both PRs as-is ships a provider revision that is not the reviewed head. **Fix:** bump the gitlink to `6a6e2d0`.

### 4. `wasmer.toml` publishes to a personal namespace — **CONFIRMED**

`packages/edgejs/wasmer.toml` — `name` changed `wasmer/edgejs` → `syrusakbary/edgejs` (version 0.1.4 → 0.1.14). Looks like a local-testing override; merging it means releases publish under the personal namespace and consumers pinned to `wasmer/edgejs` stop receiving updates. **Fix:** revert to `wasmer/edgejs` before merge (or confirm intentional).

---

## High severity

### 5. Heap snapshot / profile JSON now materialized inside the inspected isolate — **CONFIRMED**

`packages/napi/v8/src/unofficial_napi.cc:2920` (also `profile_stop` at 2876/2889)

`take_heap_snapshot`/`profile_stop` replaced the malloc'd `char**` + `unofficial_napi_free_buffer` contract with `napi_create_string_utf8(env, …)` — the full JSON is allocated as a V8 string **inside the isolate being inspected**:

- `worker.getHeapSnapshot()` runs on the worker's own thread via the interrupt path (`binding_worker.cc:873-884`). Snapshot JSON is ≈ heap-sized, so a worker above roughly half its `resource_limits` ceiling trips `WorkerNearHeapLimit` → killed with `ERR_WORKER_OUT_OF_MEMORY` **during the diagnostic that exists for memory-heavy workers**. The old off-heap path succeeded.
- Snapshots above `v8::String::kMaxLength` (≈512 MB on 64-bit) now fail outright.
- The consumer immediately copies the string back out to `std::string` (`CopyUtf8String`) anyway — net one extra full copy.

**Fix:** keep an out-of-heap return contract — malloc buffer, external string, or a chunked stream callback.

### 6. `getOwnNonIndexProperties` enumerates every array index through the bridge — **CONFIRMED**

`packages/edgejs/src/edge_util.cc:1449` + `packages/napi/quickjs/src/internal/napi_util.cc:657`

The engine-level `unofficial_napi_get_own_non_index_properties` (V8: `IndexFilter::kSkipIndices`; QuickJS: native atom scan; one bridge call) was deleted. The edgejs replacement calls `napi_get_all_property_names(…, keep_numbers)` and filters in the binding: `napi_get_element` + `napi_typeof` per key (+ `napi_set_element` for kept keys). In the wasm build each of those is a guest→host crossing.

**Impact:** `console.log`/`util.inspect` of a 1M-element array/typed array/Buffer (`inspect.js:987/1014`, `buffer.js:924`) or `assert.deepEqual` on arrays (`comparisons.js:292/330`) now materializes ~1M index keys and ~2M bridge crossings plus ~1M handles in a single scope — versus one call returning a handful of names. (Messaging serialization is *not* affected — arrays are branched off before this path.)

**Compounding on QuickJS:** the `keep_numbers` path runs `property_key_to_array_index` on every key, which does a full `JS_ToCStringLen` malloc + UTF-8 convert + free per **string** key before any screening (`napi_util.cc:24-59`) — thousands of transient allocations per wide-object enumeration.

**Fix:** restore an engine-side index-skip (e.g. an index-filter flag on `napi_get_all_property_names`), and screen atoms (tag check / first-char peek) before converting.

### 7. Bridge `profile_stop` destroys the guest handle before a fallible provider call — **CONFIRMED**

`packages/napi/src/napi_bridge_init.cc:3528-3533`

`profile_handles.Take(profile_id)` removes the handle **before** calling `unofficial_napi_profile_stop`, with no re-insert on failure. The V8 provider can fail while leaving the session live: `if (!IsEnvThreadEntered(env)) return napi_cannot_run_js;` (unofficial_napi.cc:2852) runs before the session is erased or the profiler stopped. After that: every retry returns `napi_invalid_arg` (handle gone), the profiler keeps sampling until env teardown, and for heap profiles a restart also fails (`profile_start` sees the orphaned session → busy, 2771-2781).

**Fix:** call the provider first and `Take()` only on `napi_ok` (or re-`Store` on failure).

### 8. nextTick trampoline resolves `Reflect` from the mutable global per dispatch — **CONFIRMED**

`packages/edgejs/src/edge_task_queue.cc:89-92`

The trampoline script is `(function processTicksAndRejections(recv, callback) { return Reflect.apply(callback, recv, []); })` — compiled once at bootstrap, but `Reflect` is a free variable resolved against the global object **at every dispatch**. `globalThis.Reflect = undefined` (safe in Node, which uses primordials) then makes every drain throw before the tick callback runs; `kHasTickScheduled` never clears, so the env dies with an uncaught TypeError or hot-loops `uncaughtException`.

Related (same function, line ~87/106): `tick_callback_ref` is installed before the trampoline compiles, with no rollback if `napi_run_script`/`napi_create_reference` fails — every checkpoint then returns `napi_generic_failure` (the fatal *"Failed to complete the provider event-loop checkpoint"* path) with the root cause swallowed. Low reachability, trivial fix.

**Fix:** capture the callback in a closure at setup time (no dispatch-time global lookups); install `tick_callback_ref` only after the trampoline compiles.

### 9. HTTP parser `consume()` swallows ReadStart failure — **CONFIRMED (sweep)**

`packages/edgejs/src/edge_http_parser.cc:1096`

`ParserConsume`'s new ReadStart transaction rolls back the listener transfer on a non-`ENOTCONN` error (`ClearConsumedStreamBinding`) but still **returns undefined (success)**; the `napi_reference_ref` failure path does the same. The JS http layer then believes the parser owns a socket it doesn't — data bypasses the parser and the request/response **stalls silently** instead of erroring (e.g. `consume()` on a socket that just errored/closed).

**Fix:** surface the failure (throw or return an error code) after rollback.

### 10. QuickJS submodule bump: `CallSite.getThis()` skips strict-mode censoring — **CONFIRMED (sweep)**

`packages/napi/quickjs/deps/quickjs` bump `9d5513a..ff1471c` (`quickjs.c:63233`)

The bump wires `CallSite.getThis()`/`getTypeName()` to the live receiver (`js_new_callsite_data` unconditionally dups `sf->this_val`) **without** V8's strict-mode censoring, even though `sf->is_strict_mode` is available. `Error.prepareStackTrace` / `util.getCallSites` on QuickJS therefore exposes the actual `this` of strict-mode/ESM frames — including receivers of `node:` internal functions. Sandboxed/vm code can harvest privileged receiver objects from errors thrown through internal frames: a capability leak and an observable provider divergence.

**Fix:** censor `getThis`/`getTypeName` for strict-mode frames in the vendored patch (mirror V8).

---

## Medium severity

### 11. JS-host bridge runs bytecode handles of any shape as scripts — **CONFIRMED**

`packages/napi/src/snapi_js.rs:3947` — the browser host validates shape at *open* time but stores only the source string (`bytecodes: HashMap<u32, JsValue>`), so `contextify_run_script`/`compile_function`/`create_source_text_module` accept a handle of **any** shape and evaluate it. Both native providers reject mismatches with `napi_invalid_arg` per the header contract (`unofficial_napi.h:491` — "bytecode is only usable by APIs that compile the same shape"). A module-shaped handle passed to `run_script` runs `export const x = 1` as a classic script → SyntaxError or divergent semantics per provider. **Fix:** store the shape tag with each entry and reject mismatches.

### 12. Invalid guest cache pointer silently downgraded to a cache miss — **CONFIRMED**

`packages/napi/src/guest/napi.rs:1330-1334` — `read_guest_bytes(...).unwrap_or_default()` turns an out-of-bounds `cache_ptr/length` into empty bytes with `has_cache` still set; providers report `cache_rejected=1` and recompile, and edgejs deletes + rewrites the sidecar every run — masking the caller bug and thrashing the cache. Inconsistent with the same function's own handling three lines up (options-struct read failure → status 1) and with the pre-PR `bytecode_deserialize` contract (`napi_invalid_arg`). **Fix:** `let Some(bytes) = read_guest_bytes(...) else { return 1 };`

### 13. QuickJS `create_env` never releases `guest_heap_ctx` — **CONFIRMED (latent)**

`packages/napi/quickjs/src/unofficial_napi.cc:196-207` — the header contract says the ctx is "released exactly once … on env-creation failure"; V8 releases it on every failure path (1880-1919). QuickJS never reads, installs, or releases it on **any** path. Latent today (the wasm bridge links only the V8 provider; native edgejs passes no ctx), but a real per-failure leak the moment the bridge is built against QuickJS. **Fix:** mirror V8's `napi_host_guest_heap_release` calls.

### 14. Rejected `cachedData` pays a full discarded compile — **CONFIRMED**

`packages/edgejs/src/internal_binding/binding_module_wrap.cc:500` — vm semantics require throwing `ERR_VM_MODULE_CACHED_DATA_REJECTED` on rejection, but the merged `bytecode_open` contract makes compile-on-reject mandatory (the code's own comment concedes it). QuickJS: one wasted compile + serialization after a cheap hash rejection (pre-PR: zero). V8: **two** full compiles (`kConsumeCodeCache` compiles before flagging rejection, then the mandatory eager fallback) vs one pre-PR. **Fix:** add a validate-only flag to `unofficial_napi_bytecode_open_options` (the size/version machinery exists for exactly this).

### 15. Hand-rolled ABI decoders duplicated across both Rust bridges — and already drifted — **CONFIRMED**

`packages/napi/src/guest/napi.rs:104` vs `src/guest/napi_js.rs:134` — the five versioned descriptors are decoded at hand-written byte offsets duplicated verbatim between the two guest bridges, and the twin `read_guest_js_source` helpers have already diverged: napi.rs returns a `(0,0)` sentinel that callers forward to the bridge; napi_js.rs returns `Option` and errors out first. A malformed descriptor already behaves differently per host, and every future version bump is a three-file hand edit where a missed offset is silent wasm32 corruption. **Fix:** one shared `#[repr(C)]`/generated layout module consumed by both bridges.

---

## Second tier (confirmed, below the report cap)

| # | Finding | Location | Notes |
|---|---|---|---|
| 16 | `kHeapSpaces` fallback dropped: `InitV8` installs the property only when the snapshot succeeds; pre-PR always pre-created an empty array. Provider failure ⇒ `require('v8')` throws TypeError (`lib/v8.js:160`). Latent — current providers can't realistically fail. | `packages/edgejs/src/internal_binding/binding_v8.cc:362` | defense-in-depth |
| 17 | Per-space heap stats now O(n²): `V8UpdateHeapSpaceStatisticsBuffer` takes a **full** snapshot per index and `lib/v8.js` loops all spaces ⇒ ~81 engine queries for ~9 spaces (was 9); each call allocs/zeroes ~1.5 KB. | `packages/edgejs/src/internal_binding/binding_v8.cc:248-252` | snapshot once per JS call |
| 18 | `getStatus`/`getError`/`hasTopLevelAwait` each call `get_state`, which materializes the error handle and recomputes TLA/`IsGraphAsync` per poll (was a plain int read). Hot during module loading; reclaimed per callback, not a leak. | `packages/edgejs/src/internal_binding/binding_module_wrap.cc:826-871` | status-only fast path |
| 19 | Positions-only error query pays full stderr-line + "Thrown at" stack formatting (+ possible native→JS source-map round trip, doubly redundant — the JS caller re-resolves maps itself). Cold path: only assert-failure formatting. | `packages/napi/v8/src/unofficial_napi_error_utils.cc:440-471` | field-request mask |
| 20 | HTTP/2 `ConsumeHTTP2Data` rewritten from O(1) offset advance to copying the whole unconsumed buffer per call, twice per pause/resume cycle — quadratic churn on flow-controlled large streams. | `packages/edgejs/src/internal_binding/binding_http2.cc:2123` | sweep finding |
| 21 | `bytecode_open` cache-validate-then-fallback orchestration (~40 lines incl. the empty-bytes ⇒ `cache_rejected` policy) duplicated verbatim in both C++ providers; the host-JS third copy deliberately rejects all caches. Both providers already share `lib/src`. | `packages/napi/v8/src/unofficial_napi_contextify.cc:1902` + `quickjs/src/unofficial_napi.cc:940` | shared open-transaction helper |
| 22 | `IsValidJsSource` re-implements `unofficial_napi_js_source_is_valid` (header, same PR) condition-for-condition; QuickJS already calls the header helper. 10-line deletion. | `packages/napi/v8/src/unofficial_napi_contextify.cc:1486` | |
| 23 | Tagged-source cast ternary repeated 3× in QuickJS; V8 factored the same pattern into `BytecodeRecordFromSource`. Helper belongs in `quickjs/src/internal/napi_bytecode.h` (already included by both call-site files). | `packages/napi/quickjs/src/internal/napi_contextify.cc:755, 861` + `napi_module_wrap.cc:464` | |
| 24 | `CopyUtf8String` duplicates `ValueToUtf8` in the same translation unit (3 call sites, all convertible). | `packages/edgejs/src/internal_binding/binding_worker.cc:585` | |
| 25 | `has_top_level_await` lives in both `module_create_result` and `module_state`; the state-based getter `ModuleWrapHasTopLevelAwait` is **dead code** (absent from the proto table) — the only live surface reads the cached creation value. Drop the state field + dead getter. | `packages/napi/include/unofficial_napi.h:621/665` | ABI touch in both repos |
| 26 | `error_metadata.was_preserved` is write-only: threaded through 4 layers, zero production readers (edgejs null-checks `stderr_line`/`thrown_at`, which is exact); only `test_14_exception.cc` asserts it. | `packages/napi/include/unofficial_napi.h:241` | |
| 27 | `attached_napi_envs` HashSet duplicates provider-side attach-once enforcement — **but** the JS backend (`snapi_js.rs:3477`) genuinely lacks the check, so removal must add the one-shot flag there (mandatory, not optional). | `packages/napi/src/env.rs:133` | |
| 28 | Heap-statistics struct is a field-for-field `v8::HeapStatistics` mirror; QuickJS aliases (`array_buffer_memory = external_memory`) and host-JS invents values (`native_contexts: 1`) with no validity mask — consumers can't tell real from filler; `memoryUsage` needs only 4 of 15 fields. | `packages/napi/include/unofficial_napi.h:332-348` | engine-neutral core + V8-shaped extension |
| 29 | `BuildJavascriptHeap`/`WriteReportJavascriptHeap` hard-code 0 for nine fields the snapshot they now hold actually populates on V8 (global handles, malloced/peak, contexts, executable/available, zap), duplicated in both functions which already diverge on `memoryLimit` sourcing. | `packages/edgejs/src/edge_process.cc:1796/2727` | one shared mapping helper |
| 30 | Deleted test pins: `__quickjs_contextified` non-enumerability assertions (deleted because the test went engine-neutral — needs an engine-guarded replacement, the invariant is now untested) and `queueDestroyAsyncId` deferred-destroy drain coverage (deleted in the same PR that rewrote the foreground-task machinery that performs it). | `packages/napi/tests/runners/test_65_unofficial_contextify.cc:100`, `packages/edgejs/tests/runners/test_5_internal_binding_parity_phase03.cc:61` | test-coverage |

**Plausible (mechanism real, trigger uncertain):**

- **Unguarded `node:arrowMessage` read** in QuickJS `get_error_metadata` (`napi_contextify.cc:655`): `throw null` / throwing-Proxy errors make the previously side-effect-free positions query inject a fresh pending TypeError. No in-tree path regresses (pre-PR code did the same read first), but the positions-only JS binding is newly exposed — worth a `JS_IsObject` guard.
- **Unversioned public structs** (`heap_statistics` field appended; no size/version on result structs the wasm host writes blindly at fixed offsets): no silent skew is reachable in *this* transition (import renames force loud instantiation failures), but the next same-name layout change would corrupt silently. Adopt the size/version prelude uniformly (also: `size_t` vs `uint32_t size` inconsistency across descriptor structs).
- **Sidecar refresh choreography** duplicated between the ESM and CJS paths — pre-existing duplication that this PR actually *shrank* via `EdgeBytecode`; finishing the job with an `OpenWithSidecar` helper is optional follow-up.

---

## Refuted candidates (checked, not real — don't re-chase)

| Candidate | Why it's not a bug |
|---|---|
| Dispose-time message drop is a use-after-free (bridge drops leftover cross-env messages after envs/allocators are released) | V8's `array_buffer_allocator_shared` contract: every `BackingStore` holds a `shared_ptr` to the allocator, so the deleter can't run against a freed allocator. The new drop loop **fixes a leak**. Also `message_create` has no transfer list — the claimed trigger can't occur. |
| QuickJS `take_preserved` mode losing the stderr arrow line | `was_preserved=false` + NULL `stderr_line` is the documented "nothing preserved" answer; the only consumer falls back to current-mode metadata which returns the same `node:arrowMessage`. Output unchanged. |
| `OnImmediateCheck` do-while can spin forever when timers-host state is missing | The trigger state is unreachable: the slot is never torn down mid-life, `internalBinding('timers')` isn't user-reachable, immediates can't exist before `setupTimers`, and teardown flips `can_call_into_js()` which exits the loop. Mirrors Node's own `CheckImmediate`. |
| Wasm bridge silently discards 5 of 7 attach-env hooks (worker env leak on WASIX) | Pre-existing behavior: on the bridged build the old hook registration was compiled out entirely (`#if EDGE_EMBEDDED_NAPI_PROVIDER`), fatal/OOM hooks never worked on the bridge either, and worker teardown runs cleanup/at-exit/release explicitly. Nothing regresses. (Pre-existing note: no bridged path ever removes `g_environments` entries.) |
| Write-once `attach_env` contract removes post-attach hook updates | Deliberate, documented design ("immutable, exactly-once transition" in the surface-audit doc), pinned by `test_21_general.cc:96-98`. No in-tree caller re-attaches. |
| `js_source.kind` tag is redundant state | Factually redundant (validators reject tag/pointer disagreement), but it's the audit doc's explicit prescription ("a tagged source descriptor") — a design decision, not an oversight. |
| Trampoline failure escalates to the fatal checkpoint error (C7's original mechanism) | JS throws surface as `napi_pending_exception`, which the checkpoint explicitly exempts — they route to `uncaughtException`, not the fatal branch. (The wedge itself is real; see finding 8.) |

---

## Verified-clean areas

- Symbol/ABI/build tracing: zero surviving callers of deleted APIs; 66-function import parity across guest decls, native bridge, and JS provider; all struct offsets match on wasm32; all build lists consistent.
- Deleted APIs with no replacement (`set_pending_exception`, `dispose_context`, sigint watchdog, `compile_function_for_cjs_loader`, `get_caller_location`, `get_current_stack_trace`, `import_module_dynamically`) had no callers outside napi's own deleted tests — matching the per-symbol audit doc.
- High-risk migrations verified: stack limit → isolate create-params; memory-info hooks → create options (WASIX 1 GiB cap preserved); foreground-task unbind → `cleanup_started` guard (no use-after-free — `PlatformTaskState` retired to a process-global list); source-map + dynamic-import hook merges mirrored in edgejs; `hasAsyncGraph` throw moved provider → binding correctly; `process.memoryUsage` parity via `array_buffer_memory` on both engines; message take/drop consume-semantics honored by RAII guard + atomic handle table; module-handle lookups fail closed on stale handles.
- The dual-copy `edge_napi_embedder_hooks.{h,cc}` problem is **resolved** by these PRs (napi's copy deleted; edgejs consumes `unofficial_napi.h` via the submodule).
- QuickJS vendored-fork compatibility patches (promise hooks, WASIX atomics) survive the submodule bump.
- Conventions: no CLAUDE.md/AGENTS.md violations in either diff.

---

*Review executed by Claude Code (multi-agent, xhigh effort): 11 finder angles, 17 verifier agents, 1 gap-sweep pass; verdicts backed by quoted code, `origin/main` comparison, and one native-binary reproduction.*
