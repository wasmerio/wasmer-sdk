#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check that every published SDK package has one version"
    )
    parser.add_argument(
        "tag",
        nargs="?",
        help="optional release tag in the form v<version>",
    )
    parser.add_argument(
        "--check-registries",
        action="store_true",
        help="fail if this version already exists in any target registry",
    )
    parser.add_argument(
        "--skip-crates",
        action="store_true",
        help="exclude crates.io while Rust publication is disabled",
    )
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[2]
    versions = {
        "rust/wasmer-sdk": cargo_version(repository / "rust/Cargo.toml"),
        "rust/wasmer-sdk-uniffi": cargo_version(
            repository / "rust/uniffi/Cargo.toml"
        ),
        "js/@wasmer/sdk": json.loads(
            (repository / "js/package.json").read_text()
        )["version"],
        "python/wasmer-sdk": section_value(
            repository / "python/pyproject.toml", "project", "version"
        ),
    }

    unique = set(versions.values())
    if len(unique) != 1:
        details = ", ".join(
            f"{package}={version}" for package, version in versions.items()
        )
        raise SystemExit(f"package versions do not match: {details}")

    version = unique.pop()
    if args.tag is not None:
        if not args.tag.startswith("v"):
            raise SystemExit("release tags must have the form v<version>")
        if args.tag[1:] != version:
            raise SystemExit(
                f"tag {args.tag!r} does not match package version {version!r}"
            )

    if args.check_registries:
        registries = [
            ("npm/@wasmer/sdk", npm_exists("@wasmer/sdk", version)),
            ("PyPI/wasmer-sdk", pypi_exists("wasmer-sdk", version)),
        ]
        if not args.skip_crates:
            registries = [
                ("crates.io/wasmer-sdk", crate_exists("wasmer-sdk", version)),
                (
                    "crates.io/wasmer-sdk-uniffi",
                    crate_exists("wasmer-sdk-uniffi", version),
                ),
                *registries,
            ]
        existing = [
            package
            for package, exists in registries
            if exists
        ]
        if existing:
            raise SystemExit(
                f"version {version} is already published to: "
                + ", ".join(existing)
            )

    print(f"release version: {version}")


def cargo_version(path: Path) -> str:
    return section_value(path, "package", "version")


def section_value(path: Path, section: str, key: str) -> str:
    active = False
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if line.startswith("[") and line.endswith("]"):
            active = line == f"[{section}]"
            continue
        if not active or "=" not in line:
            continue
        candidate, value = (part.strip() for part in line.split("=", 1))
        if candidate == key:
            return value.strip("\"'")
    raise SystemExit(f"{path}: [{section}] has no {key!r}")


def crate_exists(name: str, version: str) -> bool:
    normalized = name.lower().replace("_", "-")
    if len(normalized) == 1:
        path = f"1/{normalized}"
    elif len(normalized) == 2:
        path = f"2/{normalized}"
    elif len(normalized) == 3:
        path = f"3/{normalized[0]}/{normalized}"
    else:
        path = f"{normalized[:2]}/{normalized[2:4]}/{normalized}"
    contents = fetch(f"https://index.crates.io/{path}")
    if contents is None:
        return False
    return any(
        json.loads(line)["vers"] == version
        for line in contents.decode().splitlines()
    )


def npm_exists(name: str, version: str) -> bool:
    url = (
        "https://registry.npmjs.org/"
        f"{quote(name, safe='')}/{quote(version, safe='')}"
    )
    return fetch(url) is not None


def pypi_exists(name: str, version: str) -> bool:
    url = (
        "https://pypi.org/pypi/"
        f"{quote(name, safe='')}/{quote(version, safe='')}/json"
    )
    return fetch(url) is not None


def fetch(url: str) -> bytes | None:
    request = Request(url, headers={"User-Agent": "wasmer-sdk-release-check"})
    try:
        with urlopen(request, timeout=20) as response:
            return response.read()
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


if __name__ == "__main__":
    main()
