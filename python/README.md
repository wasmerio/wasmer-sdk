# Wasmer SDK for Python

Run Wasmer packages in lightweight, composable sandboxes from Python. The
public API is handwritten and typed; a Python-independent UniFFI library calls
the Rust `wasmer-sdk` underneath.

## Package download progress

```python
packages = await wasmer.packages.load_many(
    ["wasmer/bash", "python/python"],
    on_progress=lambda p: print(p.phase.value, p.download.percent, p.download.downloaded_bytes),
)
```

`packages.load` and `sandbox.install_package` accept the same keyword-only
`on_progress`. `sandboxes.create` accepts `on_package_progress`. Snapshots are
immutable dataclasses and use Python's `None` for an unknown total/percentage.
Callbacks run on the calling asyncio loop. An exception is reported through
the loop's exception handler and detaches the observer without failing the
load. Cancelling the asyncio task cancels its acquisition.

Progress is a snapshot, not a delta. `download` contains downloaded bytes, an
optional total, and an optional percentage from 0 to 100. Totals include the
unique required package artifacts and their dependencies, weighted by bytes.
Unknown sizes stay indeterminate. Counts describe decoded package bodies;
SDK cache hits and local sources add zero download bytes. An entirely cached
or local load reports 0 bytes of 0 and 100%.

The phases are `resolving`, `downloading`, `loading`, and `ready`. Downloading
can overlap resolution. 100% means the transfer is complete; await the load
before using the package. The callback does not cover SDK initialization,
guest execution, or guest `npm`/`pip` downloads. The final `ready` snapshot is
delivered before a successful load returns, with no callbacks after settlement.
Errors use the existing load error channel and do not emit `ready`.

Batch results preserve input order. Concurrent loads on the same client share
in-flight downloads. Cancelling one caller does not interrupt other callers;
cancelling the last subscriber stops its acquisition. Callbacks are serialized
per operation, coalesced to about ten byte updates per second, with phase changes
and completion delivered promptly. Keep callbacks short.

## Install

```console
pip install wasmer-sdk
```

Published wheels support macOS and Linux on arm64 and x86_64. One wheel works
across supported Python 3 versions on the same platform because the native
boundary does not use the CPython ABI.

## Load or create a package from Wasm

Load a single raw WASI/WASIX module with
`pkg = await wasmer.packages.load(Path("hello.wasm").read_bytes())`.
Byte sources detect Wasm or WEBC by their contents. Raw modules must export
`_start`; their single command and entrypoint are named `main` automatically.
Run with `sandbox.command(pkg)` or `sandbox.command("main")`. WEBC packages
retain their declared commands and entrypoint.

Create a reusable package from module bytes and optional bundled files:

```python
from pathlib import Path
from wasmer_sdk import PackageCommandDefinition, PackageDefinition, Wasmer

async def run_module():
    async with Wasmer() as wasmer:
        pkg = await wasmer.packages.create(PackageDefinition(
            modules={"app": Path("hello.wasm").read_bytes()},
            commands={"hello": PackageCommandDefinition(module="app")},
            files={"/data/config.json": '{"debug":true}'},
        ))
        async with await wasmer.sandboxes.create(packages=[pkg]) as sandbox:
            print((await sandbox.command(pkg, ["--help"]).run()).text())
```

Creation copies module and file data into an in-memory package without a WEBC
archive. Command modules must export `_start` and run with the existing
WASI/WASIX runner. One command becomes the entrypoint automatically; with
multiple commands, set `entrypoint="hello"` or select `pkg.command("hello")`.
File keys are absolute guest paths without `.` or `..` segments. Package file
writes use private execution overlays; use the sandbox workspace for persistent
data. The result also works with `sandbox.install_package(pkg)`.

## Run Python inside Wasmer

```python
import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    wasmer = Wasmer()
    sandbox = await wasmer.sandboxes.create(
        packages=["python/python@=3.13.20"],
        files={
            "main.py": "print(sum(n * n for n in range(10)))",
        },
    )
    output = await sandbox.command(
        "python", ["/workspace/main.py"]
    ).run()
    print(output.text())


asyncio.run(main())
```

The `@=` package-version syntax is an exact pin. Use it when a sandbox must
resolve the same Wasmer package version on every run.

Constructing `Wasmer()` is synchronous. Operations that perform I/O are
awaited. A `wasmer` instance can be reused across multiple sandboxes. For
long-lived applications and tests, use `async with` for deterministic cleanup:

```python
async def main() -> None:
    async with Wasmer() as wasmer:
        sandbox = await wasmer.sandboxes.create(
            packages=["python/python@=3.13.20"],
        )
        async with sandbox:
            output = await sandbox.command(
                "python", ["--version"]
            ).run()
            print(output.text())


asyncio.run(main())
```

`run()` raises `ProcessExitError` for a non-zero exit, termination, or timeout
by default. Pass `check=False` when the outcome is expected and should be
inspected as an `Output`. Spawned-process `wait()` remains unchecked by
default.

Live processes expose asynchronous stdin, stdout, and stderr streams.
`process.stdout.lines()` is an async iterator suitable for servers and agent
loops.

## Networking and caching

Network access is an explicit sandbox capability:

```python
sandbox = await wasmer.sandboxes.create(
    packages=["wasmer/edgejs@0.2.0"],
    network="host",
)
```

Packages and native compiled artifacts are cached in `.wasmer` by default:

```python
wasmer = Wasmer(cache_root=".cache/wasmer")
```

The registry and downloaded package layout is shared with Node.js and Rust.
Compiled artifacts remain target-specific.

## Examples

Run the same guest programs used by the JavaScript and Rust SDK examples:

```console
python3 python/examples/python.py
python3 python/examples/multiple_runtimes.py
python3 python/examples/edgejs_http.py
python3 python/examples/postgres_psql.py
```

The PostgreSQL example requires `psql` on `PATH`; pass
`--psql /path/to/psql` otherwise. The common guest inputs live in
[`../fixtures/`](../fixtures).

## Build and test locally

From the repository root, install Rust 1.95 and build the UniFFI module:

```console
rustup toolchain install 1.95.0 --profile minimal
python3 python/scripts/build.py --release
```

Binary releases contain Python 3 wheels for Linux x86_64/ARM64 and macOS
Intel/Apple Silicon. Each wheel has a `py3-none` ABI tag; a separate wheel per
Python minor version is unnecessary. The exact wheels published to PyPI are
also attached to `wasmer-sdk-python-v<version>` GitHub releases with checksums.

The builder enables native V8/Node-API integration on Linux x86_64 and macOS
Apple Silicon. The pinned V8 build does not support Linux ARM64 or macOS Intel;
those wheels use the `sys` backend for Wasm/WASI/WASIX and do not support native
N-API guests such as Edge.js. Use `--backend sys` or `--backend napi-v8` to select
the backend explicitly when building locally.

Run the Python suite against that local module:

```console
PYTHONPATH=python/src \
  python3 -m unittest discover -s python/tests -v
```

Run an individual example against the local build:

```console
PYTHONPATH=python/src python3 python/examples/python.py
```

The PostgreSQL tests require native `psql`. Set `PSQL=/path/to/psql` when it is
not on `PATH`.

The generated `_native.py` module and platform library are private
implementation details. Applications should import only from `wasmer_sdk`.
