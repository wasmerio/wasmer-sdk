# Python BoltFFI prototype

Status: working prototype alongside the UniFFI implementation  
BoltFFI version: 0.28.0

## Goal and layout

This prototype evaluates BoltFFI as the native language boundary for
`wasmer-sdk` without changing the Rust SDK or removing the existing UniFFI
facade:

- `rust/boltffi`: Rust-to-BoltFFI facade and package configuration
- `python/scripts/build_boltffi.py`, `python/examples/boltffi_python_package.py`,
  and `python/tests/test_boltffi_native.py`: build, example, and regression
  proof alongside the primary Python SDK

The facade exposes Rust-owned BoltFFI classes directly: `Wasmer`, `Package`,
`Sandbox`, `Command`, `Process`, `SandboxFileSystem`, and `Ports`. There is no
SDK-specific global handle registry. BoltFFI owns the foreign handles and
object destruction.

Every client uses the same dedicated Tokio runtime arrangement as the UniFFI
facade. Constructing `Wasmer` is synchronous. Package loading, sandbox startup,
commands, streams, termination, filesystem operations, and port readiness are
asynchronous and appear as `asyncio` methods.

The prototype covers:

- registry, local-file, and in-memory WEBC loading and installation
- package objects as command selectors
- captured output and spawned processes
- piped stdin, stdout, and stderr
- wait, terminate, and kill
- sandbox filesystem operations
- port readiness
- automatic Rust-object release from Python

## Generated boundary API

```python
import asyncio
import wasmer_sdk_boltffi_native as sdk


async def main() -> None:
    client = sdk.Wasmer(None, 16 * 1024 * 1024)
    sandbox = await client.create_sandbox(
        ["python/python@3.12"],
        {"main.py": b"print('hello from BoltFFI')"},
        {},
        sdk.NetworkMode.DISABLED,
    )

    output = await sandbox.command(
        "python",
        ["/workspace/main.py"],
        None,
        {},
    ).run(sdk.RunOptions(None, 30_000, None))

    print(bytes(output.stdout).decode())
    await sandbox.close()


asyncio.run(main())
```

This example intentionally shows the generated ABI layer. A production package
should put the same handwritten ergonomic layer used by the UniFFI Python SDK
on top, retaining polymorphic package sources, `Output.text()`, `check=True`,
stream iteration, and Python duration values without forcing those
conveniences into the FFI contract.

## Findings

### What works

- Classes map naturally, including async methods returning new Rust-owned
  classes.
- Rust futures map to `asyncio`, with cancellation in BoltFFI's generated
  future bridge.
- Python type stubs and native-object cleanup are generated.
- The full package → sandbox → command → process/filesystem path works against
  a real Wasmer registry package.
- The client constructor remains synchronous.

### Current constraints

1. **Python wheels are interpreter-specific.** BoltFFI 0.28 generates a CPython
   C extension. The tested wheel is tagged `cp314-cp314`, not `abi3` or
   pure-Python. Distribution therefore needs a wheel per Python version. This
   differs from the UniFFI prototype's `ctypes` loader.

2. **Local `thiserror` dependencies trigger a scanner false positive.**
   BoltFFI 0.28 mistakes attributes such as `#[error("not found")]` for its
   empty `#[error]` marker. Because `wasmer-sdk` is a path dependency,
   generation fails without a small detector correction.
   `python/scripts/build_boltffi.py` applies that correction to an
   isolated copy under `target/`; it never modifies the Cargo registry.

3. **Async borrowed class parameters are not emitted.**
   `async fn install_package(&self, package: &Package)` generates metadata but
   wrapper emission rejects the reference parameter. The prototype retains the
   registry/path/bytes install forms. The synchronous
   `command_package(&Package, ...)` selector works.

4. **Structured SDK errors are deferred.** The facade currently uses BoltFFI's
   `Result<T, String>` form, preserving the SDK code as `CODE: message`. A
   production implementation should restore a typed error after the scanner
   collision is fixed upstream.

## Build and verify

```bash
python3.14 python/scripts/build_boltffi.py \
  --release \
  --python python3.14

python3.14 -m venv python/.venv
python/.venv/bin/python -m pip install \
  python/wheelhouse/wasmer_sdk_boltffi_native-*.whl

python/.venv/bin/python -m unittest \
  python/tests/test_boltffi_native.py -v

python/.venv/bin/python \
  python/examples/boltffi_python_package.py
```

## Recommendation

Keep the BoltFFI implementation in parallel for now. Its generated class and
async model is a strong fit and the Rust facade is less annotation-heavy than
the UniFFI equivalent. It is not yet a drop-in distribution replacement
because its wheel is tied to a CPython ABI and its local-dependency scanner
needs a workaround.

The next adoption gates are:

1. upstream the `thiserror` detector correction;
2. decide whether per-version wheels are acceptable or `abi3` is required;
3. combine the generated native module with the ergonomic Python layer in one
   distribution;
4. run the existing Edge.js and Postgres regressions through that public layer.
