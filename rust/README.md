# `wasmer-sdk` for Rust

Build package-first WASIX sandboxes directly into a Rust application. The SDK
owns package resolution, caching, sandbox filesystems, command execution, live
process streams, networking, and termination on top of Wasmer.

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

## Run Python inside Wasmer

```rust
use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("python/python@3.13.5")
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

`WasmerConfig::default()` stores registry metadata, packages, and compiled
artifacts in `.wasmer`. Use `CacheConfig` to select another root. Registry and
package data can be shared with Python and Node.js, while compiled artifacts
are partitioned by native target.

## Examples

Run the same guest programs used by the JavaScript and Python SDK examples:

```console
cargo +1.94.0 run --locked -p wasmer-sdk --example python
cargo +1.94.0 run --locked -p wasmer-sdk --example multiple_runtimes
cargo +1.94.0 run --locked -p wasmer-sdk --example edgejs_http
cargo +1.94.0 run --locked -p wasmer-sdk --example postgres_psql
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
