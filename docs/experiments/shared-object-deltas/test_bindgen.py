#!/usr/bin/env python3
"""Run the delta-transport regression using a patched SDK and Wasmer checkout."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk", type=Path)
    parser.add_argument("runtime", type=Path)
    args = parser.parse_args()
    sdk, runtime = args.sdk.resolve(), args.runtime.resolve()
    patches = {
        "virtual-fs": "lib/virtual-fs", "virtual-mio": "lib/virtual-io",
        "virtual-net": "lib/virtual-net", "wasmer": "lib/api",
        "wasmer-c-api-imports": "lib/c-api-imports", "wasmer-config": "lib/config",
        "wasmer-napi": "lib/napi", "wasmer-package": "lib/package",
        "wasmer-types": "lib/types", "wasmer-wasix": "lib/wasix",
        "wasmer-wasix-types": "lib/wasi-types",
    }
    command = ["cargo", "+nightly", "test"]
    for name, path in patches.items():
        command += ["--config", f"patch.crates-io.{name}.path={json.dumps(str(runtime / path))}"]
    command += ["-p", "wasmer-sdk-js", "--lib", "--target", "wasm32-unknown-unknown",
                "tasks::interop::tests"]
    with tempfile.TemporaryDirectory(prefix="wasmer-delta-tests-") as temporary:
        Path(temporary, "node_modules").symlink_to(sdk / "js/node_modules", target_is_directory=True)
        env = {**os.environ, "TMPDIR": temporary, "TMP": temporary, "TEMP": temporary,
               "CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER": "wasm-bindgen-test-runner"}
        return subprocess.run(command, cwd=sdk, env=env).returncode


if __name__ == "__main__":
    raise SystemExit(main())
