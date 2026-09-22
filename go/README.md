# Wasmer SDK for Go

Run WASI/WASIX packages through the shared Rust SDK and UniFFI. Go 1.26+, cgo,
and a C toolchain are required. Released packages do not require Rust.

The initial Go release and `go.wasmer.io` endpoint must be published before the
release installation commands below become available. Source builds work today.

## Install a release

```sh
go get go.wasmer.io/sdk@v0.1.0
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 install
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 exec -- go build ./...
```

The source module includes the generated Go bindings and C header. The installer
downloads the matching native archive from the
[Go GitHub release](https://github.com/wasmerio/wasmer-sdk/releases/tag/wasmer-sdk-go-v0.1.0),
checks its SHA-256 against the manifest embedded in the Go module, and installs it
outside Go's module cache. Use the helper version matching the SDK in `go.mod`.
`install --archive /path/to/archive.tar.gz` supports predownloaded files.
`WASMER_SDK_NATIVE_CACHE` overrides the cache location. Installation is explicit;
`exec` verifies the installed files and never downloads a missing native archive.

The default links the SDK statically. System libraries such as libc and C++ may
still be dynamic. To use the shared SDK library:

```sh
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 exec --link dynamic -- go build ./...
```

For IDEs or an existing build system, `env --link static` prints shell exports.
The helper's dynamic mode embeds the development cache path. For deployment,
copy the archive's `dynamic` directory beside the executable as `lib`, and build
with a relocatable runtime search path: `$ORIGIN/lib` on Linux or
`@executable_path/lib` on macOS. Keep the build-time `-L` pointing at the installed
archive, and pass `-lwasmer_sdk_uniffi`. Preserve any dependent libraries alongside
it. Code signing and distribution requirements for a macOS application apply to
its embedded dylib too.

| Target | Native backend |
| --- | --- |
| Linux amd64 (glibc) | `napi-v8` |
| Linux arm64 (glibc) | `sys` |
| macOS arm64 | `napi-v8` |
| macOS amd64 | `sys` |

The Linux release build/test baseline is Ubuntu 22.04 (glibc 2.35). macOS native
artifacts target macOS 12 or newer; CI tests current macOS runners. Edge.js native
N-API requires the `napi-v8` targets. Windows, Alpine/musl, mobile and
`CGO_ENABLED=0` SDK builds are unsupported. Cross-compiling also requires a target
C toolchain; setting GOOS/GOARCH and downloading its archive is not sufficient.

## Use

```go
package main

import (
    "fmt"
    "time"
    wasmer "go.wasmer.io/sdk"
)

func main() {
    client, err := wasmer.New(wasmer.Options{})
    if err != nil { panic(err) }
    defer client.Close()

    python, err := client.Packages.Load("python/python@=3.13.20")
    if err != nil { panic(err) }
    sandbox, err := client.Sandboxes.Create(wasmer.SandboxOptions{
        Packages: []*wasmer.Package{python},
        Files: map[string][]byte{"hello.py": []byte("print('Hello from Go!')")},
    })
    if err != nil { panic(err) }
    defer sandbox.Close()

    output, err := sandbox.Command("python", "/workspace/hello.py").Run(
        wasmer.RunOptions{Timeout: 10 * time.Second},
    )
    if err != nil { panic(err) }
    fmt.Print(output.Stdout.Text())
}
```

`Packages.LoadPath`, `LoadBytes`, and `Create` also support local packages and raw
Wasm. `Sandbox.Install` adds registry packages after creation; `InstallPath`,
`InstallBytes`, and `InstallPackage` handle other sources. `sandbox.FS` exposes
files and directories, and `sandbox.Ports.Wait` waits for a guest service.

`Run` checks the exit status by default; set `Unchecked: true` to inspect a failure.
`Spawn` returns a process with optional `io.WriteCloser` stdin and `io.Reader`
stdout/stderr. Drain both piped outputs concurrently or choose capture/discard;
waiting before draining a full pipe can block. `Wait` returns unchecked output.
Use `errors.As` with `*wasmer.Error` for SDK codes or `*wasmer.ProcessExitError`
for unsuccessful checked commands.

Calls block their goroutine; independent calls may execute concurrently. Explicit
timeouts, `Terminate`, and `Kill` are supported. There is no general
`context.Context` cancellation contract yet. `Close` is idempotent: closing a
client closes its sandboxes and processes, unblocks their work, and destroys the
owned native handles. Closing a sandbox terminates its processes. Packages can
be closed explicitly to release their Go-owned handles early. Do not mutate input
maps or byte slices while a call is using them.

## Examples

Runnable examples match the Node and Python SDKs and use the same guest programs
from the repository's `fixtures/` directory:

- [Python](examples/python/main.go): load Python and execute `hello.py` in a sandbox.
- [Multiple runtimes](examples/multiple_runtimes/main.go): run shell tools, Python, Edge.js, and PHP in one sandbox.
- [Edge.js HTTP](examples/edgejs_http/main.go): start a server, wait for its port, make an HTTP request, and terminate it.
- [PostgreSQL](examples/postgres_psql/main.go): start PostgreSQL and execute the shared SQL query with native `psql`.

After building from source, run these commands from the repository root:

```sh
python3.13 go/scripts/run_example.py python
python3.13 go/scripts/run_example.py multiple_runtimes
python3.13 go/scripts/run_example.py edgejs_http
python3.13 go/scripts/run_example.py postgres_psql
```

Pass `--link dynamic` before the example name to use the shared library. The
Edge.js and multiple-runtime examples require a `napi-v8` build (macOS arm64 or
Linux amd64). PostgreSQL needs port 5432 available and `psql` on `PATH`, or pass
`postgres_psql --psql /path/to/psql`.

Examples and their embedded guest programs are also included in the released Go
module. After installing a release in your application, run one with:

```sh
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 exec -- go run go.wasmer.io/sdk/examples/python
```

## Build and test from source

```sh
python3.13 go/scripts/build.py --release
python3.13 go/scripts/test.py --link static --race
python3.13 go/scripts/test.py --link dynamic
WASMER_GO_INTEGRATION=1 python3.13 go/scripts/test.py
node --test go/proxy/*.test.mjs
```

Use Rust 1.95.0 and Go 1.26+. On Linux, install `patchelf`. The script pins the
UniFFI 0.32-compatible generator revision in `generator.json` and builds it in
`go/.build`. Generated bindings, native outputs, and copied test fixtures are
ignored by Git. The Rust facade and Python/Swift bindings are unchanged.

To test release installation locally, including the Node module proxy:

```sh
python3.13 .github/scripts/go_release.py native --native go/Artifacts/darwin-arm64 --assets go/.build/release
python3.13 .github/scripts/go_release.py module --local --assets go/.build/release
python3.13 go/scripts/test_release.py --assets go/.build/release
```

Choose the host's target directory. `--local` permits one target for testing;
publication requires all four. See [proxy deployment](proxy/README.md) and the
[SDK release guide](../docs/releases.md) for publishing.
