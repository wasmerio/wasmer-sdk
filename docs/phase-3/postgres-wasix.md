# `wasmer/pglite`: PostgreSQL for WASIX

Version 0.1.3: verified with the native SDK and the iOS 27 simulator on September 23, 2026.

`wasmer/pglite@0.1.3` contains PostgreSQL 18.4 compiled for WASIX, its
Oliphaunt runtime tree, and an initialized database. PostgreSQL itself owns a
loopback TCP socket and speaks the standard wire protocol directly to native
clients. There is no native PostgreSQL server or protocol proxy.

## Package contract

The package exports one command, `pglite`, and declares it as its entrypoint:

```toml
[package]
name = "wasmer/pglite"
version = "0.1.3"
entrypoint = "pglite"

[[command]]
name = "pglite"
module = "pglite"
runner = "wasi"
```

The command annotations in the published package manifest define PostgreSQL's working
directory, fixed launch arguments, runtime environment, and default port
`5432`. Callers therefore select the package itself as the command:

```rust
let pglite = wasmer
    .packages()
    .load("wasmer/pglite@0.1.3")
    .await?;
let sandbox = wasmer
    .sandboxes()
    .create()
    .package(pglite.clone())
    .network(NetworkPolicy::Host)
    .await?;
let process = sandbox.command(pglite).spawn().await?;
```

Networking remains an explicit sandbox capability. Packages may define how a
process starts, but may not silently grant host access.

The package maps its immutable runtime tree at `/` and initialized database at
`/base`. Wasmer presents package files through a writable copy-on-write layer,
so each sandbox can mutate its database without changing the published
container.

## Build and publish

Build output is intentionally excluded from Git. Apply the
[direct WASIX socket patch](../../rust/examples/postgres-wasix/postgres-18.4-direct-wasix-socket.patch)
and [SQL error-recovery patch](../../rust/examples/postgres-wasix/postgres-18.4-wasix-sigsetjmp.patch)
to the Oliphaunt PostgreSQL sources. Rebuild all objects with wasixcc 0.4.4
using `-sWASM_EXCEPTIONS=exnref -sRUN_WASM_OPT=no -mno-wide-arithmetic`.
This emits standard WebAssembly exceptions directly; no conversion step is
needed. Wide arithmetic is disabled for the tested iOS WebKit.

Assemble the rebuilt module, Oliphaunt runtime tree and initialized `PGDATA`
using the published package manifest, then validate and build:

```console
wasmer package build --check /path/to/pglite-package
wasmer package build /path/to/pglite-package -o wasmer-pglite-0.1.3.webc
```

See the [Swift example](../../swift/Examples/WasmerPostgres/README.md) for
running a local package and testing its Swift client integration.

Run the published package directly:

```console
wasmer run wasmer/pglite@0.1.3 --net
```

The `--net` flag grants host networking; package metadata cannot enable it.

## Verified execution

The Rust example resolves `wasmer/pglite@0.1.3` from the registry:

```console
cargo run -p wasmer-sdk --example postgres_psql -- \
  /opt/homebrew/opt/libpq/bin/psql
```

The Python example also resolves `wasmer/pglite@0.1.3`:

```console
PYTHONPATH=python/src \
  python3 python/examples/postgres_psql.py
```

The shared SQL fixture checks the PostgreSQL version and result `42`, then
recovers from division by zero inside a transaction and runs another query.
The initial query is:

```sql
select version(), 40 + 2 as answer;
```

The verified result is:

```text
PostgreSQL 18.4 on wasm32-unknown-wasix, compiled by wasixcc 0.4.3, 32-bit|42
```

The built WEBC is approximately 77 MB. The module in version 0.1.3 has SHA-256:

```text
60ae9919bfeec4c6f40e60279879e1aeaf90ef1bc514719286dc2c487bec500e
```

## Why PostgreSQL was rebuilt

The original Oliphaunt artifact processed wire frames supplied through
exported host callbacks but did not open a command-mode socket. The rebuilt
module adds a direct WASIX path which binds, listens, accepts one standard
PostgreSQL client, runs the normal frontend/backend protocol loop, and exits
after that client disconnects.

The source delta is preserved as
[`postgres-18.4-direct-wasix-socket.patch`](../../rust/examples/postgres-wasix/postgres-18.4-direct-wasix-socket.patch).
Version 0.1.3 was built with `wasixcc 0.4.4` and standard exceptions.
PostgreSQL retains its original configure-time compiler string (`0.4.3`)
in `version()`; the target is `wasm32-unknown-wasix`.

This remains a single-backend, single-client process rather than a concurrent
PostgreSQL postmaster. Unix-domain sockets are outside the current proof.
