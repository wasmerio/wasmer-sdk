#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate the Python wasmer-sdk release metadata"
    )
    parser.add_argument(
        "tag",
        nargs="?",
        help="optional release tag in the form v<version>",
    )
    parser.add_argument(
        "--check-registries",
        action="store_true",
        help="fail if this version already exists on PyPI",
    )
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[2]
    manifest = repository / "python/pyproject.toml"
    package_name = section_value(manifest, "project", "name")
    if package_name != "wasmer-sdk":
        raise SystemExit(
            f"{manifest}: expected project name 'wasmer-sdk', got {package_name!r}"
        )
    version = section_value(manifest, "project", "version")
    if args.tag is not None:
        if not args.tag.startswith("v"):
            raise SystemExit("release tags must have the form v<version>")
        if args.tag[1:] != version:
            raise SystemExit(
                f"tag {args.tag!r} does not match package version {version!r}"
            )

    if args.check_registries:
        if pypi_exists(package_name, version):
            raise SystemExit(
                f"{package_name} {version} is already published to PyPI"
            )

    print(f"Python release: {package_name} {version}")


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
