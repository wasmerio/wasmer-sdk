# Universal Wasmer SDK

This repository is the design and implementation workspace for a universal SDK
for running Wasmer packages from Rust, Python, JavaScript, Swift, and additional
host languages.

The work is intentionally split into three phases:

| Phase | Status | Deliverable |
| --- | --- | --- |
| 1. Architecture | Complete (draft for review) | [Architecture](docs/phase-1/architecture.md) and [decision log](docs/phase-1/decisions.md) |
| 2. SDK and developer experience | Complete (draft for review) | [SDK design and migration](docs/phase-2/sdk-design.md), [sandbox SDK comparison](docs/phase-2/sandbox-sdk-comparison.md), [cache design](docs/phase-2/cache-design.md), [examples](docs/phase-2/examples.md), and [decision log](docs/phase-2/decisions.md) |
| 3. Implementation and proofs of concept | In progress | [Rust implementation status](docs/phase-3/rust-sdk.md), followed by browser, Node.js, Python, and Swift proofs of concept |

Phase 1 defines the system boundaries and feasibility constraints. Phase 2
defines the proposed public API and developer experience. Phase 3 is now
validating that contract with executable vertical slices.

## Rust SDK

The workspace now contains the `wasmer-sdk` crate. Its first native slice can
load registry packages, local WEBC files, in-memory WEBC bytes, or local
package directories; create a persistent sandbox workspace; install packages
after creation; execute captured or live commands; terminate processes; and
mount external filesystem providers:

```rust
use wasmer_sdk::{PackageSource, Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandbox()
        .package(PackageSource::path("./my-package"))
        .file("input.txt", b"hello".to_vec())
        .start()
        .await?;

    let output = sandbox
        .command("my-command")
        .arg("/workspace/input.txt")
        .output()
        .await?;

    println!("{}", output.text()?);
    Ok(())
}
```

Live process I/O uses Tokio's standard traits:

```rust
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::Stdio;

let mut process = sandbox
    .command("my-command")
    .stdin(Stdio::Piped)
    .spawn()
    .await?;

let mut stdin = process.take_stdin().expect("piped stdin");
let mut stdout = process.take_stdout().expect("piped stdout");

stdin.write_all(b"hello\n").await?;
stdin.close().await?;

let mut bytes = Vec::new();
stdout.read_to_end(&mut bytes).await?;
let output = process.wait().await?;
```

External filesystems are explicit capabilities:

```rust
use std::sync::Arc;
use wasmer_sdk::{Directory, FileSystem, MountMode};

let project = Directory::new();
project.write_text("input.txt", "hello").await?;

let provider: Arc<dyn FileSystem> = Arc::new(project);
let sandbox = wasmer
    .sandbox()
    .mount("/project", provider, MountMode::ReadOnly)
    .start()
    .await?;
```

Run the network-free local-package proof with:

```console
cargo test --all-targets
```

The PostgreSQL 18 WASIX proof starts a rebuilt single-backend PostgreSQL
command through this SDK. The guest owns the loopback TCP socket, and a
separately installed standard `psql` connects directly to it:

```console
cargo run --example postgres_wasix_psql -- \
  <postgres-wasix-module> \
  <oliphaunt-runtime-root> \
  <initialized-pgdata> \
  <psql>
```

There is no native server or PostgreSQL protocol proxy in that path. See
[the PostgreSQL WASIX proof](docs/phase-3/postgres-wasix.md) for the source
patch, exact artifact layout, and locally verified command.

The Edge.js HTTP example loads `wasmer/edgejs-quickjs`, seeds a Node-compatible
`server.js`, starts it with host networking, and verifies the resulting site
with a real HTTP request:

```console
cargo run --example edgejs_http
```

Its JavaScript source is in
[`examples/edgejs-http/server.js`](examples/edgejs-http/server.js).

## JavaScript SDK

The JavaScript SDK is a `wasm-bindgen` facade over this Rust crate, compiled
with Wasmer's `js` backend, WASIX, atomics, and shared memory. Blocking WASIX
work runs in a dynamic Web Worker pool modeled on `wasmer-js`. Node networking
is supplied by a JavaScript virtual-network adapter over `node:net` and
`node:dns`; it is not a native addon.

```ts
import { Wasmer } from "@wasmer/sdk/node";

const client = new Wasmer();
const sandbox = await client.createSandbox({
  packages: ["python/python@3.12"],
});

const output = await sandbox
  .command("python", ["--version"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.shutdown();
```

See [the JavaScript implementation notes](docs/phase-3/javascript-sdk.md) for
the package layout, worker scheduler, Node network bridge, and build
instructions.
