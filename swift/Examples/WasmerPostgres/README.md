# Wasmer Postgres

A native SwiftUI SQL console inspired by Oliphaunt's iOS example. PostgreSQL
18.4 runs as WASIX inside WasmerSDK's invisible WKWebView. A Swift
[PostgresNIO](https://github.com/vapor/postgres-nio) connection speaks the real
PostgreSQL wire protocol through `sandbox.ports.forwardTCP(5432)`.

The console provides sample queries, a SQL editor, results, query history,
timings, and a PostgreSQL log. It keeps one connection open for the session.
Results retain at most 100 rows and display at most 4,000 characters per cell;
the client still drains the full response.

## Run on the simulator

Requires Xcode 27 with an iOS 27+ simulator, XcodeGen, and the SDK's browser
build prerequisites. From the repository root:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm
python3 swift/Examples/WasmerPostgres/build.py
```

The script generates an Xcode project, resolves PostgresNIO, builds the local
Swift SDK and browser runtime, and launches the app. Generated projects,
packages and binaries are not committed. The new TCP bridge requires the local
runtime until an SDK release includes it; `build.py` sets
`WASMER_SDK_LOCAL_WEB_RUNTIME=1` for this reason.

### PostgreSQL package fix

The example loads `wasmer/pglite@0.1.2`, which fixes an uncaught Wasm exception
on SQL errors caused by the `sigsetjmp` wrapper in version 0.1.0, and uses standard
exception instructions compatible with both WebKit and the native SDK. To rebuild
the corrected package yourself, apply
[`postgres-18.4-wasix-sigsetjmp.patch`](../../../rust/examples/postgres-wasix/postgres-18.4-wasix-sigsetjmp.patch)
to the Oliphaunt PostgreSQL sources, alongside the existing direct-socket patch,
and rebuild all affected objects. This keeps `setjmp` in the actual caller,
where LLVM can generate the exception recovery block.

Build all objects with wasixcc 0.4.4 using
`-sWASM_EXCEPTIONS=exnref -sRUN_WASM_OPT=no -mno-wide-arithmetic` to emit standard
WebAssembly exceptions directly. Legacy exceptions are unsupported by the
native SDK; version 0.1.1 used that format. Version 0.1.2 already contains
standard exceptions, but used an intermediate conversion that new builds do
not need. Disabling wide arithmetic avoids instructions unsupported by the
tested iOS WebKit. Package the rebuilt module with the runtime files and
initialized database, then run:

```sh
python3 swift/Examples/WasmerPostgres/build.py --pglite-webc /path/to/pglite-fixed.webc
python3 swift/Examples/WasmerPostgres/build.py --pglite-webc /path/to/pglite-fixed.webc --test
```

`--test` uses the actual Swift client to check SQL, parameter binding, Unicode,
transactions, JSONB/NULL values, error recovery, a 1 MiB parameter, an 8 MiB
result, repeated queries, and two session resets. It writes `Documents/test-result.json` in the
simulator app container and exits nonzero on failure. The unpatched registry
package is expected to fail the error-recovery check.

## Swift connection

```swift
let wasmer = try Wasmer()
let package = try await wasmer.packages.load("wasmer/pglite@0.1.2")
let sandbox = try await wasmer.sandboxes.create(
    packages: [.package(package)], network: .host
)
let process = try await sandbox.command(package).spawn()
let port = try await sandbox.ports.forwardTCP(5432)
let connection = try await PostgresConnection.connect(
    configuration: .init(host: port.host, port: Int(port.port),
                         username: "postgres", password: nil,
                         database: "postgres", tls: .disable),
    id: 1, logger: .init(label: "postgres")
)
let rows = try await connection.query(
    "SELECT 6 * 7 AS answer", logger: .init(label: "postgres")
)
for try await answer in rows.decode(Int.self) { print(answer) }
```

Use `.file(packageURL)` instead of the registry name to test a local build.
Retain `wasmer`, `sandbox`, `process`, `port`, and `connection` for the
session. Close the connection and port, then the sandbox/client when done.
TCP forwarding binds only to `127.0.0.1`, chooses a free native port, and keeps
bounded buffers in both directions. It does not interpret PostgreSQL messages.

## Scope

- This is the Oliphaunt-derived `wasmer/pglite` package, not the ElectricSQL
  JavaScript `@electric-sql/pglite` API.
- It is a single-backend PostgreSQL build. It accepts one client and exits
  when that client disconnects. Use one `PostgresConnection`, not a pool.
- Database files live in the sandbox's in-memory package overlay. Resetting
  the session or terminating the app discards data. Durable PGDATA storage is
  not implemented by this example.
- Multiprocess services, concurrent clients, replication, extension coverage,
  and background execution are outside this demonstration. Passing its tests
  is not equivalent to passing PostgreSQL's full regression suite.
- Validation targets the iOS 27 simulator. Physical-device validation remains
  a separate step.
