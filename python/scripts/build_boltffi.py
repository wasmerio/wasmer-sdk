#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path


BOLTFFI_VERSION = "0.28.0"

OLD_DETECTOR = """            Item::Struct(item_struct) => {
                Self::has_any_attribute(&item_struct.attrs, &["ffi_record", "data", "error"])
                    || Self::has_ffi_type_derive(&item_struct.attrs)
            }
            Item::Enum(item_enum) => Self::has_any_attribute(&item_enum.attrs, &["data", "error"]),
"""

NEW_DETECTOR = """            Item::Struct(item_struct) => {
                Self::has_any_attribute(&item_struct.attrs, &["ffi_record", "data"])
                    || Self::has_empty_error_attribute(&item_struct.attrs)
                    || Self::has_ffi_type_derive(&item_struct.attrs)
            }
            Item::Enum(item_enum) => {
                Self::has_any_attribute(&item_enum.attrs, &["data"])
                    || Self::has_empty_error_attribute(&item_enum.attrs)
            }
"""

INSERT_AFTER = """    fn has_ffi_type_derive(attrs: &[Attribute]) -> bool {
"""

HELPER = """    fn has_empty_error_attribute(attrs: &[Attribute]) -> bool {
        attrs.iter().any(|attr| {
            matches!(&attr.meta, syn::Meta::Path(path) if path.segments.last().is_some_and(|segment| segment.ident == "error"))
        })
    }

"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the BoltFFI Python prototype")
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--python", default="python3")
    args = parser.parse_args()

    package_root = Path(__file__).resolve().parents[1]
    workspace = package_root.parent
    facade = workspace / "rust" / "boltffi"
    compatibility = workspace / "target" / "boltffi-compat"
    tools = compatibility / "tools"
    boltffi = tools / "bin" / "boltffi"

    if not boltffi.exists():
        run(
            [
                "cargo",
                "install",
                "boltffi_cli",
                "--version",
                BOLTFFI_VERSION,
                "--locked",
                "--root",
                str(tools),
            ],
            workspace,
        )

    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    scanner_source = find_scanner(cargo_home)
    patched_scanner = compatibility / "boltffi_scan"
    if patched_scanner.exists():
        shutil.rmtree(patched_scanner)
    shutil.copytree(scanner_source, patched_scanner)
    patch_scanner(patched_scanner / "src" / "package_graph.rs")

    isolated_home = compatibility / "cargo-home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    for directory in ("registry", "git"):
        source = cargo_home / directory
        destination = isolated_home / directory
        if source.exists() and not destination.exists():
            destination.symlink_to(source, target_is_directory=True)

    config = isolated_home / "config.toml"
    config.write_text(
        "[patch.crates-io]\n"
        f'boltffi_scan = {{ path = "{patched_scanner}" }}\n'
    )

    command = [str(boltffi), "pack", "python", "--python", args.python]
    if args.release:
        command.append("--release")
    environment = dict(os.environ)
    environment["CARGO_HOME"] = str(isolated_home)
    lockfile = workspace / "Cargo.lock"
    original_lockfile = lockfile.read_bytes()
    try:
        run(command, facade, environment)
    finally:
        lockfile.write_bytes(original_lockfile)


def find_scanner(cargo_home: Path) -> Path:
    matches = sorted(
        (cargo_home / "registry" / "src").glob(
            f"*/boltffi_scan-{BOLTFFI_VERSION}"
        )
    )
    if not matches:
        raise SystemExit(
            f"boltffi_scan {BOLTFFI_VERSION} was not downloaded after installing BoltFFI"
        )
    return matches[-1]


def patch_scanner(path: Path) -> None:
    source = path.read_text()
    if OLD_DETECTOR not in source:
        raise SystemExit(f"unexpected BoltFFI scanner source at {path}")
    source = source.replace(OLD_DETECTOR, NEW_DETECTOR, 1)
    source = source.replace(INSERT_AFTER, HELPER + INSERT_AFTER, 1)
    path.write_text(source)


def run(
    command: list[str],
    cwd: Path,
    environment: dict[str, str] | None = None,
) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd, env=environment, check=True)


if __name__ == "__main__":
    main()
