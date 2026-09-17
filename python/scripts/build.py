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
    parser.add_argument(
        "--backend", choices=("auto", "sys", "napi-v8"), default="auto",
        help="auto enables native N-API only on targets supported by the pinned V8 build",
    )
    args = parser.parse_args()
    backend = args.backend
    if backend == "auto":
        backend = default_backend()

    package_root = Path(__file__).resolve().parents[1]
    workspace = package_root.parent
    profile = "release" if args.release else "debug"
    library_name = native_library_name()
    library = workspace / "target" / profile / library_name

    build = [
        "cargo",
        "build",
        "--locked",
        "-p",
        "wasmer-sdk-uniffi",
        "--no-default-features",
        "--features",
        f"{backend},bindgen-cli",
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
        destination = package_root / "src" / "wasmer_sdk"
        shutil.copy2(generated / "wasmer_sdk_uniffi.py", destination / "_native.py")
        shutil.copy2(library, destination / library_name)

    print(f"built {package_root / 'src' / 'wasmer_sdk'}")


def default_backend() -> str:
    system, machine = platform.system(), platform.machine().lower()
    supports_v8 = (
        (system == "Darwin" and machine in ("arm64", "aarch64"))
        or (system in ("Linux", "Windows") and machine in ("x86_64", "amd64"))
    )
    return "napi-v8" if supports_v8 else "sys"


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
