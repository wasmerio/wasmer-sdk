# SDK experiments: duplicate transport and worker locality

September 18, 2026. These experiments follow the
[receiver-collection investigation](ios-webkit-memory-research.md). Two consecutive
worker-locality runs complete the full iOS workload that the unchanged SDK
fails. Avoiding duplicate object transport alone does not provide that result.

## Comparison

| SDK variant | iOS full stress | Chromium full stress |
| --- | --- | --- |
| Unchanged control | 46/175, `RangeError: Out of memory` | Previous 45/45 pass |
| Per-connection object deltas | 19/175, timeout after pip reports a successful Django install | 45/45 pass |
| Reuse most recently idle worker | **175/175 pass, twice** | 45/45 pass |

The iOS workload installs Flask five times and Django/FastAPI requirements
three times each, without the pip download cache. It then launches Python 150
times through the terminal keyboard path, tests input during output pressure,
and restarts with 256 KiB of input queued. The control fails after all eleven
installs and 23 subsequent Python launches. The locality variant completes all
of them, including the final restart check.

The locality variant also passes 103 iOS quick-stress checks (100 Python
launches with three threads each, output pressure and restart), all 24 native
integration checks including Node/pnpm and server previews, and the Chromium
Node/pnpm smoke test. Neither
experiment adds GC pressure, sleeps, larger memory limits, worker termination,
or a change to the task dependency set. The execution WebView stays hidden and
unattached.

## What changes with locality

The scheduler previously took the oldest idle worker (`pop_front`) and returned
available workers to the back of the queue. Successive short jobs therefore
rotated through the idle pool. Task messages carry shared-memory references,
so this rotation can distribute guest memories across otherwise quiet worker
heaps.

The change takes the most recently available worker (`pop_back`). Blocking
workers remain excluded, and another worker is created when the idle queue is
empty. The task payload, shared-object transport, busy/idle notifications and
worker lifetimes are unchanged. This concentrates reuse instead of depending
on every idle heap to collect promptly.

The result is consistent with the earlier engine-only controls: four receivers
completed 2,000 allocations, whereas twenty failed after approximately 53.
Those controls and the collection experiment explain why locality is a useful
mitigation; they do not prove an engine defect has been fixed. The SDK still
depends on browser reclamation and can still create multiple workers when
programs need concurrency.

## Why the delta experiment remains opt-in

The [preserved patches](experiments/shared-object-deltas/README.md) add a sender
that tracks object IDs per connection and omits objects successfully sent
previously. New workers receive a fresh snapshot, and failed posts do not
advance the cache. All four interop tests pass, including the added regression.

This removes repeated copies, but every newly encountered live object can
still reach workers that do not use it. It does not establish a smaller set of
receiving heaps. Its iOS run stalls after pip prints successful installation,
before the shell completion marker; no allocation exception was captured.
The stall is not classified as OOM, and the single comparison does not establish
that the delta patch caused it. The delta implementation is not enabled in the
SDK or its bundled artifacts.

## Reproducibility and limits

The [captured results](ios-webkit-memory-experiments-results.json) record the
checks, errors and transcript tails. The
[environment and binary hashes](experiments/shared-object-deltas/environment.json)
identify the control, delta, and locality apps. Native apps were verified to
contain the intended Wasm binaries. Each run started a fresh app/WebContent
process on the dedicated iPhone 18 Pro simulator, iOS 27.0 (24A434), WebKit
8625.1.29.10.29. The simulator filesystem persisted between runs; installs
used `--force-reinstall --no-cache-dir`. Counts and heap sizes are observations,
not statistical performance estimates.

The full workload, without diagnostic collection, is the acceptance check:

```sh
python3 swift/Examples/WasmerShell/build.py stress --device <DEDICATED_IOS_27_SIMULATOR>
npm --prefix wasmer-sh run test:stress
```

Physical iPhone execution remains untested. Passing this workload does not
establish unlimited session duration or eliminate the engine-only allocation
failure. The earlier dispatcher and shared-registry fixes remain necessary;
worker locality addresses a separate part of the memory-lifetime problem.
