# Phase 3: Python SDK implementation

Status: native UniFFI vertical slice complete  
Last updated: 2026-07-28

## Shape

The Python SDK has two layers:

- `rust/uniffi` is a coarse native façade over the public
  `wasmer-sdk` Rust API. It exports FFI-safe objects, records, enums, errors,
  and bounded byte operations.
- `python/src/wasmer_sdk` is the handwritten public veneer. It owns
  Python source unions, context managers, checked output, text decoding,
  async stream iteration, line decoding, and Pythonic timeouts in seconds.

The generated UniFFI Python module is an internal implementation detail. It is
created during the build and is not the product API.

## Runtime model

UniFFI lets Python's asyncio loop drive exported Rust futures. Wasmer also
needs a Tokio reactor for registry HTTP, compilation tasks, process execution,
timers, and bounded duplex streams. Each `Wasmer` client therefore owns one
multi-threaded Tokio runtime, and every core SDK future is spawned onto it.
The UniFFI future only awaits the Tokio join handle.

Packages, sandboxes, commands, processes, filesystems, and port handles retain
that runtime context for as long as native work can reference it.

## Public API

Construction is synchronous; operations that can perform I/O are asynchronous:

```python
from wasmer_sdk import Wasmer

client = Wasmer(cache_root=".wasmer")
python = await client.packages.load("python/python@3.12")
sandbox = await client.sandboxes.create(
    packages=[python],
    files={"main.py": "print('hello')"},
    env={"APP_ENV": "test"},
)
output = await sandbox.command(
    "python", ["/workspace/main.py"]
).run(timeout=10)
print(output.text())
```

There is no `await Wasmer(...)`. `async with Wasmer(...)` remains available as
optional deterministic-cleanup sugar for long-lived applications and tests,
but it does not make construction asynchronous. `await client.close()` is
likewise optional when deterministic cleanup matters.

Package sources have unambiguous Python types:

- `str` is a registry specifier;
- `pathlib.Path` or another `os.PathLike` is a local WEBC file or package
  directory;
- `bytes`, `bytearray`, or `memoryview` is an in-memory WEBC;
- `Package` reuses an already resolved package.

`Package` is also a command selector and runs its entrypoint. A
`Package.command(name)` returns a package-qualified `CommandRef`.

Local and in-memory packages use the same object model:

```python
from pathlib import Path

local = await client.packages.load(Path("./dist/tool.webc"))
in_memory = await client.packages.load(webc_bytes)
sandbox = await client.sandboxes.create(packages=[local, in_memory])
```

Commands are reusable immutable descriptions:

```python
command = sandbox.command("python", ["--version"])
first = await command.run()
second = await command.run()
```

`Command.run()` raises `ProcessExitError` for an unsuccessful completion by
default. `check=False` returns that outcome as `Output`. Spawned-process
`wait()` remains unchecked.

Captured text decoding is synchronous. `Output.text()` checks success before
decoding stdout, while `output.stdout.text()` only decodes the retained bytes.

`Wasmer()` inherits the Rust core's `.wasmer` cache root. Passing
`cache_root=Path(...)` relocates both the package cache and target-separated
compiled-artifact cache; the binding does not introduce a second cache format.
Within that root, registry metadata has a short freshness window, WEBC blobs
are content-addressed, and native compiled modules survive client and Python
process restarts.

## Live processes

Spawned processes expose optional byte streams according to their configured
stdio modes:

```python
process = await sandbox.command(
    "python",
    ["-u", "-c", "print(input().upper())"],
).spawn(stdin="pipe", stderr="discard")

await process.stdin.write("hello\n")
await process.stdin.close()

async for line in process.stdout.lines():
    print(line)

await process.wait(check=True)
```

`ReadableBytes` guarantees async iteration over bounded chunks and provides an
incremental `lines()` decoder. `terminate(grace_period=...)` and `kill()` are
explicit process controls. Output retention is configured at spawn time.

## Filesystem, packages, and ports

The veneer exposes:

- `sandbox.install_package(source, as_shell=...)`;
- `sandbox.fs.write()`, `write_text()`, `read()`, `read_text()`, `mkdir()`,
  `read_dir()`, `stat()`, `remove()`, and `rename()`;
- `sandbox.ports.wait(port, timeout=...)`;
- `sandbox.shell(script)` only after an explicit shell selector is configured.

Relative filesystem keys and paths resolve beneath `/workspace`, matching the
Rust and JavaScript SDKs.

## Build and validation

Build the native library, generate its internal Python module in library mode,
and copy both beside the public package:

```console
python3 python/scripts/build.py
```

Use `--release` for the optimized artifact intended for packaging. Run:

```console
PYTHONPATH=python/src \
  python3 -m unittest discover -s python/tests -v
```

The runtime suite loads `python/python@3.12` and verifies:

- captured checked execution;
- reusable commands;
- filesystem persistence and rename;
- bounded async stdout iteration and decoded lines;
- piped stdin and EOF;
- checked nonzero exits, timeout classification, and termination;
- dynamic package installation; and
- Python-side numeric validation.

The Edge.js and PostgreSQL examples resolve their packages from the registry:

```console
PYTHONPATH=python/src \
  python3 python/examples/edgejs_http.py

PYTHONPATH=python/src \
  python3 python/examples/postgres_psql.py
```

The PostgreSQL example loads `wasmer/pglite@0.1.0`, enables host networking,
starts its package entrypoint without custom arguments or environment, and
uses the standard native `psql` client to connect to port 5432.

```console
PSQL=/absolute/path/psql \
PYTHONPATH=python/src \
  python3 -m unittest \
    python/tests/test_postgres_psql.py -v
```

If `PSQL` is omitted, the test uses `psql` from `PATH`.

The macOS development cdylib exposed an invalid compact-unwind base calculation
in the linked Wasmer checkout: JIT functions and their personality GOT slot can
be mapped below the containing dylib, so dylib-relative unsigned offsets either
panic in debug builds or point libunwind at invalid memory. The local Wasmer
patch selects and range-checks a base spanning the actual JIT image addresses,
so normal and forced guest exits work from a dynamically loaded library.

## Deliberate limitations

- The build currently produces a local platform package directory, not a
  manylinux/macOS/Windows wheel matrix.
- Foreign filesystem-provider traits and host-directory mounts are not yet
  exposed through UniFFI.
- PTYs and policy limits remain unimplemented in the Rust core.
- UniFFI cancellation is not yet mapped to SDK process termination; callers
  should use `terminate()` or `kill()` explicitly.
- Swift generation and the Swift-native veneer are the next binding slice.
