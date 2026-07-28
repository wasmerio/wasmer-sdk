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
after creation; and execute captured commands:

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

Run the network-free local-package proof with:

```console
cargo test --test local_package
```
