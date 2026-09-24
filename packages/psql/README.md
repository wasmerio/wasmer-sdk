# psql for WASIX

The PostgreSQL 18.4 command-line client, statically linked with libpq and
compiled with standard WebAssembly exceptions (`exnref`). It can connect to
`wasmer/pglite` through the Wasmer SDK's browser-local TCP network, without a
Wisp server. This is the PostgreSQL CLI, not a JavaScript reimplementation.

```sh
psql -h localhost -p 5432 -U postgres -d postgres
psql -Atc 'SELECT 6 * 7'
```

Package defaults select `localhost`, database/user `postgres`, and a 10-second
connection timeout. Override them with normal psql flags or environment
variables. This build does not include TLS, readline, or compressed COPY
support. It is intended for local virtual-network connections.

Generated binaries are excluded from Git. See `build.sh` to rebuild from
PostgreSQL 18.4 sources using wasixcc 0.4.4.

```sh
# Download/extract PostgreSQL 18.4, then:
PATH="$HOME/.wasixcc/bin:$PATH" ./build.sh /path/to/postgresql-18.4
wasmer package build . -o psql.webc
```

The build uses upstream PostgreSQL sources, not the Oliphaunt server tree.
See the source URL and archive SHA-256 in `build.sh`.
