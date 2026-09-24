# PostgreSQL and psql

Run a PostgreSQL server and the real `psql` client in wasmer.sh or the iOS
WasmerShell. Choose **PostgreSQL** under **Databases**. The example loads only
Bash, `wasmer/pglite@0.1.3`, and `wasmer/psql@18.4.0`; no installation is needed.

The SDK starts PostgreSQL alongside Bash and waits for its listening socket
without opening a probe connection. At the shell prompt, connect with:

```sh
psql
```

Both programs run as WebAssembly. Their localhost connection stays inside the
SDK's virtual network. No Wisp proxy, external database, or HTTP preview is used.

At the `postgres=#` prompt:

```sql
\i demo.sql
\dt
SELECT * FROM notes;
SELECT 1 / 0;
SELECT 42 AS recovered;
\q
```

`demo.sql` creates a table, inserts a note, and runs a few queries. You can edit
it in the web shell's editor. SQL errors do not end the session.

After `\q`, run `psql` again to reconnect. This PGlite build accepts one client
per server process, so `start-postgres.sh` starts a fresh server process after a
clean client disconnect. It also restarts after WASIX's idle accept timeout.
The database lives in `/workspace/.postgres`, and survives reconnects. Browser
and memory workspaces reset when the shell restarts; native and OPFS storage on
iOS retain the database. Closing the example stops both programs.

To run the SQL file directly from Bash:

```sh
psql -v ON_ERROR_STOP=1 -f demo.sql
```

The example uses the SDK to run `bash start-postgres.sh` alongside the terminal.
The script copies the packaged database into the workspace on first launch.
PostgreSQL's `data_directory` setting redirects writes there, instead of into a
package filesystem that would reset with each process. Server logs are in
`.postgres/server.log`. Only selecting the PostgreSQL example starts the
database automatically; the full-shell workspace includes the same source files.

The browser requires the SDK's virtual localhost support. Before its npm
release, build and link the SDK from this checkout as described in the shell
README.
