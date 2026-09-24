# `wasmer/pglite`: PostgreSQL for WASIX

Status: packaged and verified locally on July 29, 2026.

`wasmer/pglite@0.1.0` contains PostgreSQL 18.4 compiled for WASIX, its
Oliphaunt runtime tree, and an initialized database. PostgreSQL itself owns a
loopback TCP socket and speaks the standard wire protocol directly to native
clients. There is no native PostgreSQL server or protocol proxy.

## Package contract

The package exports one command, `pglite`, and declares it as its entrypoint:

```toml
[package]
name = "wasmer/pglite"
version = "0.1.0"
entrypoint = "pglite"

[[command]]
name = "pglite"
module = "pglite"
runner = "wasi"
```

The command annotations in
[`wasmer.toml`](../../packages/pglite/wasmer.toml) define PostgreSQL's working
directory, fixed launch arguments, runtime environment, and default port
`5432`. Callers therefore select the package itself as the command:

```rust
let pglite = wasmer
    .packages()
    .load("wasmer/pglite@0.1.0")
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

Build output is intentionally excluded from Git. Assemble the package from the
rebuilt module, Oliphaunt runtime tree, and initialized `PGDATA`:

```console
bash packages/pglite/build.sh \
  target/postgres-wasix-socket-build/src/backend/oliphaunt \
  /path/to/oliphaunt/runtime/root \
  .wasmer/postgres-poc/pgdata
```

The script populates the complete runnable package directly at
`packages/pglite` and builds the container at
`target/wasmer-pglite-0.1.0.webc`. Generated module, runtime, and database
directories are ignored by Git.

Run the package directly:

```console
cd packages/pglite
wasmer run . --net
```

The `--net` flag is required because networking is a host capability grant;
package metadata cannot enable it for itself.

Validate locally without publishing:

```console
wasmer package build --check packages/pglite
wasmer package push --dry-run --non-interactive packages/pglite
```

Publish when ready:

```console
wasmer package publish --wait=container packages/pglite
```

## Verified execution

The Rust example resolves `wasmer/pglite@0.1.0` from the registry:

```console
cargo run -p wasmer-sdk --example postgres_psql -- \
  /opt/homebrew/opt/libpq/bin/psql
```

The Python example also resolves `wasmer/pglite@0.1.0`:

```console
PYTHONPATH=python/src \
  python3 python/examples/postgres_psql.py
```

Both issue:

```sql
select version(), 40 + 2 as answer;
```

The verified result is:

```text
PostgreSQL 18.4 on wasm32-unknown-wasix, compiled by wasixcc 0.4.3, 32-bit|42
```

The built WEBC is approximately 71 MB. The embedded patched module retains its
verified SHA-256:

```text
ab171fd55658967c728f6d67c0c805cc76786bd5bfddaacfb1211a6ad17fc03d
```

## Why PostgreSQL was rebuilt

The original Oliphaunt artifact processed wire frames supplied through
exported host callbacks but did not open a command-mode socket. The rebuilt
module adds a direct WASIX path which binds, listens, accepts one standard
PostgreSQL client, runs the normal frontend/backend protocol loop, and exits
after that client disconnects.

The source delta is preserved as
[`postgres-18.4-direct-wasix-socket.patch`](../../rust/examples/postgres-wasix/postgres-18.4-direct-wasix-socket.patch).
The module was built with `wasixcc 0.4.3`; it identifies itself as
`wasm32-unknown-wasix`.

This remains a single-backend, single-client process rather than a concurrent
PostgreSQL postmaster. Unix-domain sockets are outside the current proof.
