#!/usr/bin/env python3
"""Select unpublished files; fail if an existing registry artifact has different bytes."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from sdk_release import require, verify


def fetch_json(url: str) -> dict | None:
    try:
        with urlopen(Request(url, headers={"User-Agent": "wasmer-sdk-release"}), timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def pending(component: str, directory: Path) -> list[Path]:
    metadata = verify(directory, component)
    value = metadata["version"]
    if component == "python":
        release = fetch_json(f"https://pypi.org/pypi/wasmer-sdk/{value}/json")
        published = {item["filename"]: item["digests"]["sha256"] for item in (release or {}).get("urls", [])}
        result = []
        for name, checksum in metadata["files"].items():
            if name in published:
                require(published[name] == checksum, f"PyPI already has different bytes for {name}")
            else:
                result.append(directory / name)
        return result
    release = fetch_json(f"https://registry.npmjs.org/@wasmer%2fsdk/{value}")
    tarball = directory / next(iter(metadata["files"]))
    if release is None:
        return [tarball]
    integrity = release["dist"].get("integrity")
    if integrity:
        actual = "sha512-" + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()
        require(integrity == actual, f"npm already has different bytes for @wasmer/sdk@{value}")
    else:
        require(release["dist"]["shasum"] == hashlib.sha1(tarball.read_bytes()).hexdigest(),
                f"npm already has different bytes for @wasmer/sdk@{value}")
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=("js", "python"), required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    require(not any(args.output.iterdir()), "Pending upload directory must be empty")
    files = pending(args.component, args.assets)
    for path in files:
        shutil.copyfile(path, args.output / path.name)
    print(f"{len(files)} artifact(s) remain to publish")


if __name__ == "__main__":
    main()
