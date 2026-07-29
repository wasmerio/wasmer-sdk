# Wasmer SDK BoltFFI prototype

This is a parallel Python binding prototype backed by
[`wasmer-sdk-boltffi`](../rust/boltffi). It intentionally leaves
the existing UniFFI binding untouched so both approaches can be compared.

The Rust facade exposes Rust-owned BoltFFI classes for the client, packages,
sandboxes, commands, processes, filesystem, and ports. Generated Python code
provides native object lifetime management and `asyncio` futures.

## Build

BoltFFI 0.28 requires Python 3.10 or newer for its Python packager. The build
script also applies an isolated compatibility patch for BoltFFI's
local-dependency scanner; it does not modify the global Cargo registry:

```bash
python3.14 python/scripts/build_boltffi.py \
  --release \
  --python python3.14
python3.14 -m pip install \
  python/wheelhouse/wasmer_sdk_boltffi_native-*.whl
```

## Smoke test

```bash
python3.14 python/examples/boltffi_python_package.py
```

The generated wheel is CPython-ABI-specific. Unlike the current UniFFI/ctypes
prototype, BoltFFI 0.28 generates a CPython C extension and therefore builds one
wheel for each configured Python interpreter.

### BoltFFI 0.28 compatibility note

BoltFFI scans local path dependencies for re-exported BoltFFI declarations. Its
0.28 detector currently mistakes `thiserror` attributes such as
`#[error("not found")]` for BoltFFI's empty `#[error]` marker. Since
`wasmer-sdk` is a local path dependency, unpatched generation fails before
reaching this facade.

The build script copies `boltffi_scan` into `target/boltffi-compat`, changes the
detector to recognize only an empty error marker, and runs BoltFFI with a
temporary Cargo home that patches that one crate. Remove the workaround once
BoltFFI ships the equivalent upstream fix.
