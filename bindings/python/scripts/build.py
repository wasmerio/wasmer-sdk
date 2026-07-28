#!/usr/bin/env python3
from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the local Python UniFFI package")
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()

    package_root = Path(__file__).resolve().parents[1]
    workspace = package_root.parents[1]
    profile = "release" if args.release else "debug"
    library_name = native_library_name()
    library = workspace / "target" / profile / library_name

    build = [
        "cargo",
        "build",
        "-p",
        "wasmer-sdk-uniffi",
        "--features",
        "bindgen-cli",
        "--lib",
        "--bin",
        "uniffi-bindgen",
    ]
    if args.release:
        build.append("--release")
    run(build, workspace)

    with tempfile.TemporaryDirectory(prefix="wasmer-sdk-uniffi-") as temp:
        generated = Path(temp)
        run(
            [
                str(workspace / "target" / profile / bindgen_name()),
                "generate",
                "--library",
                "--language",
                "python",
                "--out-dir",
                str(generated),
                str(library),
            ],
            workspace,
        )
        destination = package_root / "wasmer_sdk"
        shutil.copy2(generated / "wasmer_sdk_uniffi.py", destination / "_native.py")
        shutil.copy2(library, destination / library_name)

    print(f"built {package_root / 'wasmer_sdk'}")


def native_library_name() -> str:
    if sys.platform == "darwin":
        return "libwasmer_sdk_uniffi.dylib"
    if sys.platform == "win32":
        return "wasmer_sdk_uniffi.dll"
    return "libwasmer_sdk_uniffi.so"


def bindgen_name() -> str:
    return "uniffi-bindgen.exe" if sys.platform == "win32" else "uniffi-bindgen"


def run(command: list[str], cwd: Path) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    main()
