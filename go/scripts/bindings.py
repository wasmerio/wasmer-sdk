#!/usr/bin/env python3
"""Check committed UniFFI bindings without compiling the generator."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ("go/internal/ffi/wasmer_sdk_uniffi.go", "go/internal/ffi/wasmer_sdk_uniffi.h")
INPUTS = (
    "Cargo.toml", "Cargo.lock", "rust/uniffi/Cargo.toml", "rust/uniffi/uniffi.toml",
    "go/generator.json", "go/uniffi.toml", "go/scripts/build.py",
)
RECEIPT = "go/bindings.json"
REGENERATE = "python3.13 go/scripts/build.py --release --generate-bindings"


def snapshot(root: Path = ROOT) -> dict:
    sources = {*INPUTS, *(path.relative_to(root).as_posix()
                         for path in (root / "rust/uniffi/src").rglob("*.rs"))}

    def hashes(names):
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(names)}

    return {"schema": 1, "inputs": hashes(sources), "generated": hashes(GENERATED)}


def record(root: Path = ROOT) -> None:
    (root / RECEIPT).write_text(json.dumps(snapshot(root), indent=2) + "\n")


def check(root: Path = ROOT) -> None:
    try:
        expected = json.loads((root / RECEIPT).read_text())
        if not isinstance(expected, dict) or expected.get("schema") != 1 or any(
                not isinstance(expected.get(section), dict) for section in ("inputs", "generated")):
            raise ValueError("Invalid binding receipt")
        actual = snapshot(root)
    except (OSError, ValueError) as error:
        raise ValueError(f"Committed Go bindings or their receipt are missing/invalid. Run: {REGENERATE}") from error
    if expected != actual:
        changed = sorted(name for section in ("inputs", "generated")
                         for name in set(expected.get(section, {})) | set(actual[section])
                         if expected.get(section, {}).get(name) != actual[section].get(name))
        raise ValueError(f"Committed Go bindings are stale ({', '.join(changed)}). Run: {REGENERATE}")


if __name__ == "__main__":
    try:
        check()
    except ValueError as error:
        raise SystemExit(str(error))
    print("Committed Go bindings match their recorded inputs and generated files")
