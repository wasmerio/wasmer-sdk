# Shared-object delta experiment

This opt-in experiment sends each live shared object once per ordered worker
connection. It did **not** resolve the iOS stability failure and is not enabled
in the SDK. The patches preserve the implementation and regression for further
investigation without changing the bundled runtime.

`runtime.patch` adds `SharedObjectSender` to Wasmer's JS backend. It filters
prepared snapshots using a set of object IDs, remembers delivery only after a
successful `postMessage`, and bounds the ID set by the latest live snapshot.
It keeps no JavaScript object references. A new receiving worker gets a new
sender. `sdk.patch` applies this in both directions and adds a regression for
repeat delivery, new objects, failed posts, replacement connections and expired
owners.

This preserves the full dependency set: every newly encountered live object is
still sent to a receiver, even if that receiver's particular task does not use
it. The experiment reduces duplicate wrappers; it does not limit the number
of heaps receiving each memory. The receiver must retain imported objects
while their Rust owners are alive, and the connection must deliver messages
in order. The existing worker initialization queue preserves that order.

## Reproduce

Use disposable checkouts at the revisions recorded in [environment.json](environment.json),
with the repository's existing JS dependencies and Rust/Wasm build tools installed.
Set `EXPERIMENT` to this directory's absolute path, `SDK` to the SDK checkout,
and `RUNTIME` to the Wasmer checkout. `DEVICE` must be a dedicated iOS 27
simulator: the stress test reinstalls packages in its Documents directory.

```sh
git -C "$RUNTIME" apply --check "$EXPERIMENT/runtime.patch"
git -C "$SDK" apply --check "$EXPERIMENT/sdk.patch"
git -C "$RUNTIME" apply "$EXPERIMENT/runtime.patch"
git -C "$SDK" apply "$EXPERIMENT/sdk.patch"
python3 "$EXPERIMENT/test_bindgen.py" "$SDK" "$RUNTIME"
WASMER_REPO="$RUNTIME" npm --prefix "$SDK/js" run build:wasm
npm --prefix "$SDK/js" run build:ts
python3 "$SDK/swift/WasmerWKSDK/scripts/bundle_sdk.py"
python3 "$SDK/swift/Examples/WasmerShell/build.py" stress --device "$DEVICE"
npm --prefix "$SDK/wasmer-sh" run test:stress
```

The local runtime override also changes Cargo.lock. Use the disposable
checkouts for the entire experiment; these instructions do not publish an
artifact or update the dependency pin. The browser app must resolve
`@wasmer/sdk` to the patched SDK checkout, as it does in our development setup.

## Recorded outcome

All four interop tests pass, including the new delta regression. All 45
Chromium stress checks pass, ending with a 351,928,320-byte SDK heap. The iOS
run completed 19/175 checks, then timed out waiting for the third Django
requirements install to return to Bash. The transcript ends after pip reports
successful installation, without the shell's completion marker. This run did
not report an allocation exception, so its stall is **not classified as OOM**.

A post-timeout sample measured a 637.7 MiB WebContent footprint (880 MiB peak)
and showed worker threads waiting in Wasm atomics. The sample did not identify
the Rust wait site or establish the stall's cause. A subsequent unchanged-SDK
control on the same simulator completed 46/175 checks and reported
`RangeError: Out of memory` on the next Python launch.

Both apps' embedded Wasm hashes were verified and are recorded in the environment
file. Runs started fresh app/WebContent processes but retained the dedicated
simulator's filesystem; installs used `--force-reinstall --no-cache-dir`. The
failure counts are single-run observations, not a statistical performance or
regression claim. Neither run used forced collection, allocation pressure,
retry sleeps, or worker retirement.

See the [experiment report](../../ios-webkit-memory-experiments.md) for the
worker-locality comparison and captured results.
