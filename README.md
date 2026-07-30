# Universal Wasmer SDK

This repository is the design and implementation workspace for a universal SDK
for running Wasmer packages from Rust, Python, JavaScript, Swift, and additional
host languages.

The standalone proposal for expert review is the
[Universal Wasmer SDK WARP](docs/warp-universal-wasmer-sdk.md).

The work is intentionally split into three phases:

| Phase | Status | Deliverable |
| --- | --- | --- |
| 1. Architecture | Complete (draft for review) | [Architecture](docs/phase-1/architecture.md) and [decision log](docs/phase-1/decisions.md) |
| 2. SDK and developer experience | Complete (draft for review) | [SDK design and migration](docs/phase-2/sdk-design.md), [sandbox SDK comparison](docs/phase-2/sandbox-sdk-comparison.md), [cache design](docs/phase-2/cache-design.md), [examples](docs/phase-2/examples.md), and [decision log](docs/phase-2/decisions.md) |
| 3. Implementation and proofs of concept | In progress | [Rust](docs/phase-3/rust-sdk.md), [JavaScript](docs/phase-3/javascript-sdk.md), and [Python](docs/phase-3/python-sdk.md) implementation status, followed by Swift proofs of concept |

Phase 1 defines the system boundaries and feasibility constraints. Phase 2
defines the proposed public API and developer experience. Phase 3 is now
validating that contract with executable vertical slices.

## Repository layout

The repository is organized by public language surface. Rust owns the shared
core and native FFI facades; JavaScript owns its handwritten TypeScript API and
wasm-bindgen facade; Python owns its package, examples, tests, and build tools:

```text
/
├── rust/             # wasmer-sdk, UniFFI, BoltFFI, Rust examples and tests
├── js/               # TypeScript SDK, wasm-bindgen facade, examples and tests
├── python/           # Python SDK, examples, tests and binding build scripts
├── docs/             # architecture, SDK design and implementation notes
├── Cargo.toml        # virtual Rust workspace
└── README.md
```

`swift/` will be added when the Swift package exists; the UniFFI boundary it
will consume already lives in `rust/uniffi/`.

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
    let package = wasmer
        .packages()
        .load(PackageSource::path("./my-package"))
        .await?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package(package)
        .file("input.txt", b"hello".to_vec())
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
    .sandboxes().create()
    .mount("/project", provider, MountMode::ReadOnly)
    .await?;
```

Run the network-free local-package proof with:

```console
cargo test -p wasmer-sdk --all-targets
```

Continuous integration validates the Rust SDK and UniFFI before testing the
JavaScript and Python packages in parallel. Releases currently publish only the
Python `wasmer-sdk` package. A manually started Release Please workflow prepares
the release PR; merging it creates the version tag, rebuilds and tests every
Python wheel, and publishes to PyPI with trusted publishing. Rust and JavaScript
publication remain disabled. Registry setup and release ordering are documented in
[`docs/releasing.md`](docs/releasing.md).

The native SDK and wasm-bindgen facade share one source workspace but are
always built in separate target-specific invocations. Do not use
`cargo test --workspace`: that would select both Wasmer's mutually exclusive
`sys` and `js` feature sets for one host build.

The `wasmer/pglite@0.1.0` package starts PostgreSQL 18 through this SDK. The
package entrypoint owns PostgreSQL's arguments, environment, working directory,
runtime tree, and initialized database. The guest owns the loopback TCP
socket, and a separately installed standard `psql` connects directly to it:

```console
cargo run --example postgres_wasix_psql -- \
  <psql>
```

There is no native server or PostgreSQL protocol proxy in that path. See
[the PostgreSQL WASIX package](packages/pglite/README.md) for assembly and
publishing instructions.

The Edge.js HTTP example loads `wasmer/edgejs-quickjs`, seeds a Node-compatible
`server.js`, starts it with host networking, and verifies the resulting site
with a real HTTP request:

```console
cargo run --example edgejs_http
```

Its JavaScript source is in
[`rust/examples/edgejs-http/server.js`](rust/examples/edgejs-http/server.js).

## Python SDK

The Python SDK uses a generated UniFFI module internally and presents a
synchronously constructed client with the same asynchronous package, sandbox,
command, process, output, filesystem, and ports model:

```python
from wasmer_sdk import Wasmer

client = Wasmer()
python = await client.packages.load("python/python@3.12")
sandbox = await client.sandboxes.create(
    packages=[python],
    files={"main.py": "print(sum(n * n for n in range(10)))"},
)
output = await sandbox.command(
    "python", ["/workspace/main.py"]
).run(check=True, timeout=10)
print(output.text())
```

Build the development package and run its integration tests with:

```console
python3 python/scripts/build.py
PYTHONPATH=python/src \
  python3 -m unittest discover -s python/tests -v
```

Use `pathlib.Path` for a local package path and `bytes` for an in-memory WEBC;
plain strings are registry package specifiers. See
[the Python implementation notes](docs/phase-3/python-sdk.md) for the complete
surface and packaging status.

A parallel BoltFFI implementation is available for comparison. See
[the BoltFFI prototype notes](docs/phase-3/python-boltffi-prototype.md) and
[its build instructions](python/BOLTFFI.md).

## JavaScript SDK

The JavaScript SDK is a `wasm-bindgen` facade over this Rust crate, compiled
with Wasmer's `js` backend, WASIX, atomics, and shared memory. Blocking WASIX
work runs in a dynamic Web Worker pool modeled on `wasmer-js`. Node networking
is supplied by a JavaScript virtual-network adapter over `node:net` and
`node:dns`; it is not a native addon.

```ts
import { Wasmer } from "@wasmer/sdk2/node";

const client = new Wasmer();
const python = await client.packages.load("python/python@3.12");
const sandbox = await client.sandboxes.create({
  packages: [python],
});

const output = await sandbox
  .command("python", ["--version"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.close();
```

See [the JavaScript implementation notes](docs/phase-3/javascript-sdk.md) for
the package layout, worker scheduler, Node network bridge, and build
instructions.
