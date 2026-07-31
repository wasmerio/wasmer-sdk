# Wasmer SDK for Python

Run Wasmer packages in lightweight, composable sandboxes from Python. The
public API is handwritten and typed; a Python-independent UniFFI library calls
the Rust `wasmer-sdk` underneath.

## Install

```console
pip install wasmer-sdk
```

Published wheels support macOS and Linux on arm64 and x86_64. One wheel works
across supported Python 3 versions on the same platform because the native
boundary does not use the CPython ABI.

## Run Python inside Wasmer

```python
import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    client = Wasmer()
    sandbox = await client.sandboxes.create(
        packages=["python/python@3.13.5"],
        files={
            "main.py": "print(sum(n * n for n in range(10)))",
        },
    )
    output = await sandbox.command(
        "python", ["/workspace/main.py"]
    ).run(check=True)
    print(output.text())


asyncio.run(main())
```

Constructing `Wasmer()` is synchronous. Operations that perform I/O are
awaited. For long-lived applications and tests, use `async with` for
deterministic cleanup:

```python
async def main() -> None:
    async with Wasmer() as client:
        sandbox = await client.sandboxes.create(
            packages=["python/python@3.13.5"],
        )
        async with sandbox:
            output = await sandbox.command(
                "python", ["--version"]
            ).run(check=True)
            print(output.text())


asyncio.run(main())
```

Live processes expose asynchronous stdin, stdout, and stderr streams.
`process.stdout.lines()` is an async iterator suitable for servers and agent
loops.

## Networking and caching

Network access is an explicit sandbox capability:

```python
sandbox = await client.sandboxes.create(
    packages=["wasmer/edgejs-quickjs@0.1.0"],
    network="host",
)
```

Packages and native compiled artifacts are cached in `.wasmer` by default:

```python
client = Wasmer(cache_root=".cache/wasmer")
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

From the repository root, install Rust 1.94 and build the UniFFI module:

```console
rustup toolchain install 1.94.0 --profile minimal
python3 python/scripts/build.py --release
```

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
