#!/usr/bin/env python3
"""Attach/retrieve release bundles without replacing an existing release asset."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

from sdk_release import digest, release_tag, require, verify, version


def gh(*args: str) -> str:
    return subprocess.check_output(["gh", *args], text=True)


def upload(component: str, directory: Path) -> None:
    metadata = verify(directory, component)
    repository = os.environ["GITHUB_REPOSITORY"]
    require(metadata["repository"] == repository, "Release repository mismatch")
    tag = metadata["tag"]
    sha = gh("api", f"repos/{repository}/commits/{tag}", "--jq", ".sha").strip()
    require(sha == subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            "Release tag does not point to the checked-out commit")
    release = json.loads(gh("release", "view", tag, "--repo", repository, "--json", "assets,isDraft"))
    existing = {asset["name"] for asset in release["assets"]}
    expected = {path.name for path in directory.iterdir()}
    require(existing <= expected, "Release contains unexpected assets; refusing to modify it")
    # A retry accepts identical existing bytes; it never clobbers an artifact.
    with tempfile.TemporaryDirectory() as temp:
        for path in sorted(directory.iterdir()):
            if path.name in existing:
                gh("release", "download", tag, "--repo", repository, "--pattern", path.name, "--dir", temp)
                require(digest(Path(temp) / path.name) == digest(path), f"Existing asset differs: {path.name}")
            else:
                require(release["isDraft"], "A published release is incomplete; refusing to change its assets")
                gh("release", "upload", tag, str(path), "--repo", repository)
    if release["isDraft"]:
        gh("release", "edit", tag, "--repo", repository, "--draft=false")


def download(component: str, directory: Path) -> None:
    tag = release_tag(component, version(component))
    repository = os.environ["GITHUB_REPOSITORY"]
    directory.mkdir(parents=True, exist_ok=True)
    require(not any(directory.iterdir()), "Download directory must be empty")
    gh("release", "download", tag, "--repo", repository, "--dir", str(directory))
    metadata = verify(directory, component, tag=tag)
    require(metadata["repository"] == repository, "Release repository mismatch")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("upload", "download"))
    parser.add_argument("--component", choices=("js", "python", "swift", "go"), required=True)
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    (upload if args.command == "upload" else download)(args.component, args.assets)


if __name__ == "__main__":
    main()
