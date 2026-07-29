# PostgreSQL WASIX socket proof

Status: verified locally on July 27, 2026.

This proof has one server process and one client:

1. `wasmer-sdk` starts PostgreSQL 18.4 as a WASIX process.
2. That guest process calls `socket()`, `bind()`, `listen()`, and `accept()`.
3. A separately installed, native `psql` connects to the guest-owned TCP
   socket and executes SQL.

There is no native PostgreSQL server and no protocol proxy in this path.

## Why the artifact was rebuilt

The existing Oliphaunt artifact was an embedded, single-backend PostgreSQL
module. It could process PostgreSQL wire frames supplied through exported host
callbacks, but its command entrypoint did not open a socket. That did not meet
this proof's requirement.

The rebuilt artifact keeps Oliphaunt's one-backend model and adds a direct
command-mode socket entrypoint. Setting `OLIPHAUNT_WASIX_SOCKET_PORT` makes the
guest:

- bind an IPv4 loopback TCP listener;
- accept one standard PostgreSQL client;
- read the PostgreSQL startup packet from the socket;
- send authentication and connection metadata on the socket;
- run PostgreSQL's normal frontend/backend protocol loop; and
- shut down after that client disconnects.

The source delta is preserved as
[`postgres-18.4-direct-wasix-socket.patch`](../../rust/examples/postgres-wasix/postgres-18.4-direct-wasix-socket.patch).
It applies to the PostgreSQL 18.4 source tree prepared by Oliphaunt's WASIX
build, not to an unmodified upstream PostgreSQL tarball.

The verified module was rebuilt with `wasixcc 0.4.3` and Oliphaunt's existing
WASIX bridge. Its relevant configuration is:

```text
--host=wasm32-wasix
--with-template=wasix-dl
--without-readline
--without-icu
--without-zlib
--without-llvm
--disable-largefile
--without-pam
--with-openssl=no
```

The verified rebuilt module SHA-256 is:

```text
ab171fd55658967c728f6d67c0c805cc76786bd5bfddaacfb1211a6ad17fc03d
```

Build output under `target/` is intentionally not checked into the SDK.

## SDK composition

[`postgres_wasix_psql.rs`](../../rust/examples/postgres_wasix_psql.rs) generates a
temporary local Wasmer package with two filesystem mappings:

```toml
[fs]
"/" = "<oliphaunt-runtime-root>"
"/base" = "<initialized-pgdata>"
```

The SDK treats `/` as a copy-on-write package layer. `/base` is a distinct
writable mapping, so database changes persist in the selected `PGDATA`.

Guest sockets require an explicit network capability:

```rust
let sandbox = wasmer
    .sandbox()
    .package(PackageSource::path(package_dir))
    .network(NetworkPolicy::Host)
    .start()
    .await?;
```

`NetworkPolicy::Host` selects Wasmer WASIX's native local-networking backend.
The default `NetworkPolicy::Disabled` rejects guest socket operations.

The example then starts PostgreSQL through the SDK:

```rust
let mut postgres = sandbox.command("postgres");
postgres
    .args([
        "--single",
        "-F",
        "-O",
        "-j",
        "-c",
        "io_method=sync",
        "-D",
        "/base",
        "postgres",
    ])
    .env("OLIPHAUNT_WASIX_SOCKET_PORT", port.to_string());

let process = postgres.spawn().await?;
```

The host waits for the guest readiness marker, then invokes the local `psql`
binary. The SDK does not parse or forward PostgreSQL protocol frames.

## Run the verified proof

First unpack an initialized data directory:

```console
mkdir -p .wasmer/postgres-poc/pgdata
zstd -dc \
  /Users/syrusakbary/Development/oliphaunt/target/oliphaunt-wasix/downloads/28621618569/target/oliphaunt-wasix/assets/prepopulated/pgdata-template.tar.zst \
  | tar -xf - -C .wasmer/postgres-poc/pgdata
```

Then run:

```console
cargo run --example postgres_wasix_psql -- \
  target/postgres-wasix-socket-build/src/backend/oliphaunt \
  /Users/syrusakbary/Development/oliphaunt/target/oliphaunt-wasix/downloads/28621618569/target/oliphaunt-wasix/wasix-build/build/package-stage/runtime/oliphaunt \
  .wasmer/postgres-poc/pgdata \
  /opt/homebrew/opt/libpq/bin/psql
```

The example selects an ephemeral loopback port and runs:

```sql
select version(), 40 + 2 as answer;
```

The locally verified output was:

```text
connected directly to WASIX PostgreSQL: postgresql://postgres@127.0.0.1:<port>/postgres?sslmode=disable
PostgreSQL 18.4 on wasm32-unknown-wasix, compiled by wasixcc 0.4.3, 32-bit|42
```

## Scope of the proof

This demonstrates:

- PostgreSQL itself runs as the process spawned by `wasmer-sdk`;
- the WASIX guest owns the listening and accepted sockets;
- an unmodified local `psql` speaks the standard wire protocol directly to
  the guest;
- the database identifies itself as PostgreSQL 18.4 on
  `wasm32-unknown-wasix`;
- mutable `PGDATA` works through an SDK filesystem mapping; and
- host networking is opt-in.

It deliberately remains a single-backend, single-client process. It is not a
concurrent PostgreSQL postmaster, and Unix-domain sockets were not part of this
proof.
