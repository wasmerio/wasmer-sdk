# `wasmer-sdk` for Rust

Build package-first WASIX sandboxes directly into a Rust application. The SDK
owns package resolution, caching, sandbox filesystems, command execution, live
process streams, networking, and termination on top of Wasmer.

## Package download progress

```rust
use wasmer_sdk::{PackageLoadCancellation, PackageLoadOptions};

let cancellation = PackageLoadCancellation::default();
let packages = wasmer.packages().load_many_with_options(
    ["wasmer/bash", "python/python"],
    PackageLoadOptions::default()
        .cancellation(cancellation.clone())
        .on_progress(|p| println!("{:?}: {:?}%", p.phase, p.download.percent)),
).await?;
```

The existing `load` remains unchanged. `load_with_options` reports a single
load; `load_many` uses default options. A sandbox builder accepts
`.on_package_progress(callback)`, and dynamic installation accepts
`install_package_with_options`. Dropping a pending load future or calling the
cancellation token cancels its interest. Callbacks run outside SDK locks on the
polling task and must not block or panic.

Progress is a snapshot, not a delta. `download` contains downloaded bytes, an
optional total, and an optional percentage from 0 to 100. Totals include the
unique required package artifacts and their dependencies, weighted by bytes.
Unknown sizes stay indeterminate. Counts describe decoded package bodies;
SDK cache hits and local sources add zero download bytes. An entirely cached
or local load reports 0 bytes of 0 and 100%.

The phases are `resolving`, `downloading`, `loading`, and `ready`. Downloading
can overlap resolution. 100% means the transfer is complete; await the load
before using the package. The callback does not cover SDK initialization,
guest execution, or guest `npm`/`pip` downloads. The final `ready` snapshot is
delivered before a successful load returns, with no callbacks after settlement.
Errors use the existing load error channel and do not emit `ready`.

Batch results preserve input order. Concurrent loads on the same client share
in-flight downloads. Cancelling one caller does not interrupt other callers;
cancelling the last subscriber stops its acquisition. Callbacks are serialized
per operation, coalesced to about ten byte updates per second, with phase changes
and completion delivered promptly. Keep callbacks short.

## Use the crate

Crates.io publication is temporarily disabled while the SDK tracks Wasmer's
`sdk` branch. In this workspace, depend on the crate by path:

```toml
[dependencies]
wasmer-sdk = { path = "../wasmer-sdk/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The repository root pins the required Wasmer revisions in its
`[patch.crates-io]` section.

## Load or create a package from Wasm

For a single raw WASI/WASIX module, use
`wasmer.packages().load(wasm_bytes).await?`, where `wasm_bytes` is a `Vec<u8>`
or `bytes::Bytes`. Byte sources detect Wasm or WEBC by their contents. A raw
module must export `_start` and gets one command and entrypoint named `main`
automatically. WEBC commands and entrypoints are preserved. Use
`sandbox.command(package)` to run the package entrypoint.

`Packages::create` builds a package directly from owned module bytes and files,
without a WEBC archive or registry request:

```rust
use wasmer_sdk::{PackageCommandDefinition, PackageDefinition};

let package = wasmer.packages().create(PackageDefinition {
    modules: [("app".into(), wasm_bytes.into())].into(),
    commands: [("hello".into(), PackageCommandDefinition {
        module: "app".into(),
    })].into(),
    files: [("/data/config.json".into(), b"{}".to_vec().into())].into(),
    ..PackageDefinition::default()
}).await?;
let sandbox = wasmer.sandboxes().create().package(package.clone()).await?;
let output = sandbox.command(package).arg("--help").run().await?;
sandbox.close().await?;
```

`wasm_bytes` can be a `Vec<u8>`. Command modules must export `_start` and be
compatible with the existing WASI/WASIX runner. A sole command is the inferred
entrypoint; for multiple commands, set `entrypoint` or select a command by name.
Files use canonical absolute guest paths and private execution overlays. Use
the sandbox workspace for persistent writes. Definitions with changed commands
or files have distinct package identities even when they share module bytes.

## Run Python inside Wasmer

```rust
use wasmer_sdk::{Result, Wasmer};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new()?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("python/python@=3.13.20")
        .file(
            "main.py",
            b"print(sum(n * n for n in range(10)))".to_vec(),
        )
        .await?;

    let output = sandbox
        .command("python")
        .arg("/workspace/main.py")
        .run()
        .await?;

    println!("{}", output.text()?);
    Ok(())
}
```

Package strings can be passed directly to the sandbox builder. Load through
`wasmer.packages().load(...)` first when the application wants to inspect or
reuse a `Package`.

`Command::run()` returns `ProcessExitError` for a non-zero exit, termination,
or timeout. Use `Command::output()` when an unsuccessful outcome is expected
and should be inspected as an `Output`. Spawned-process `wait()` likewise
returns the outcome without checking it.

Live processes use Tokio I/O:

```rust
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::Stdio;

let mut process = sandbox
    .command("python")
    .args(["-u", "-c", "print(input())"])
    .stdin(Stdio::Piped)
    .stdout(Stdio::Piped)
    .spawn()
    .await?;

let mut stdin = process.take_stdin().expect("piped stdin");
let mut stdout = process.take_stdout().expect("piped stdout");
stdin.write_all(b"hello\n").await?;
stdin.close().await?;

let mut bytes = Vec::new();
stdout.read_to_end(&mut bytes).await?;
let result = process.wait().await?.check()?;
```

## Networking and caching

Grant host networking only to sandboxes that need it:

```rust
use wasmer_sdk::NetworkPolicy;

let sandbox = wasmer
    .sandboxes()
    .create()
    .package("wasmer/edgejs-quickjs@0.1.0")
    .network(NetworkPolicy::Host)
    .await?;
```

`Wasmer::new()` stores registry metadata, packages, and compiled artifacts in
`.wasmer`. Use `Wasmer::with_config(...)` and `CacheConfig` to select another
root. Registry and package data can be shared with Python and Node.js, while
compiled artifacts are partitioned by native target.

## Examples

Run the same guest programs used by the JavaScript and Python SDK examples:

```console
cargo +1.94.0 run --locked -p wasmer-sdk --example python
cargo +1.94.0 run --locked -p wasmer-sdk --example multiple_runtimes
cargo +1.94.0 run --locked -p wasmer-sdk --example edgejs_http
cargo +1.94.0 run --locked -p wasmer-sdk --example postgres_psql
cargo +1.94.0 run --locked -p wasmer-sdk --example terminal
```

The PostgreSQL example requires `psql` on `PATH`; set `PSQL` or pass its path
after `--` otherwise. The common guest inputs live in
[`../fixtures/`](../fixtures).

## Build and test locally

The native SDK currently targets Rust 1.94:

```console
rustup toolchain install 1.94.0 --profile minimal
cargo +1.94.0 test --locked -p wasmer-sdk --all-targets
```

Build and test the UniFFI facade separately:

```console
cargo +1.94.0 test --locked -p wasmer-sdk-uniffi --lib
cargo +1.94.0 build --locked \
  -p wasmer-sdk-uniffi \
  --features bindgen-cli
```

Do not enable Wasmer's `sys` and `js` backends in one Cargo invocation. The
native SDK and JavaScript wasm facade are deliberately built for separate
targets.
