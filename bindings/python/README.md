# Wasmer SDK for Python

The Python package is a typed, handwritten façade over the Rust
`wasmer-sdk`, exported through UniFFI. Package resolution, sandbox state,
commands, live processes, streams, files, and ports follow the same model as
the Rust and JavaScript SDKs.

```python
from wasmer_sdk import Wasmer

async with Wasmer(cache_root=".wasmer") as client:
    async with await client.create_sandbox(
        packages=["python/python@3.12"],
        files={"main.py": "print('hello from WASIX')"},
    ) as sandbox:
        output = await sandbox.command(
            "python", ["/workspace/main.py"]
        ).run(check=True)
        print(output.text())
```

Build the local native package and run the executable tests from the repository
root:

```console
python3 bindings/python/scripts/build.py --release
PYTHONPATH=bindings/python \
  python3 -m unittest bindings/python/tests/test_runtime.py -v
```

The generated `_native.py` module and platform library are private
implementation details. Applications should only import from `wasmer_sdk`.
