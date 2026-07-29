# Wasmer SDK for Python

The Python package is a typed, handwritten façade over the Rust
`wasmer-sdk`, exported through UniFFI. Package resolution, sandbox state,
commands, live processes, streams, files, and ports follow the same model as
the Rust and JavaScript SDKs. Constructing `Wasmer()` is synchronous; only
operations that perform I/O and deterministic shutdown are awaited.

```python
from wasmer_sdk import Wasmer

client = Wasmer(cache_root=".wasmer")
python = await client.packages.load("python/python@3.12")
sandbox = await client.sandboxes.create(
    packages=[python],
    files={"main.py": "print('hello from WASIX')"},
)
output = await sandbox.command(
    "python", ["/workspace/main.py"]
).run(check=True)
print(output.text())
```

For long-lived applications and tests, `await client.close()` or
`async with Wasmer() as client` provides deterministic cleanup.

Build the local native package and run the executable tests from the repository
root:

```console
python3 python/scripts/build.py --release
PYTHONPATH=python/src \
  python3 -m unittest discover -s python/tests -v
```

The generated `_native.py` module and platform library are private
implementation details. Applications should only import from `wasmer_sdk`.
