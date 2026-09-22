#!/usr/bin/env python3
"""Run Go tests against the local static or dynamic SDK archive."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]


def environment(native: Path, mode: str) -> dict[str, str]:
    native = native.resolve()
    metadata = json.loads((native / "native.json").read_text())
    env = dict(os.environ, CGO_ENABLED="1")
    if mode == "static":
        flags = [str(native / "static/libwasmer_sdk_uniffi.a"), *shlex.split(metadata["static_link_flags"])]
    else:
        flags = ["-L" + str(native / "dynamic"), "-lwasmer_sdk_uniffi", "-Wl,-rpath," + str(native / "dynamic")]
    # cgo's quoted.Split understands double quotes, not shell escape sequences.
    env["CGO_LDFLAGS"] = " ".join(json.dumps(f) for f in flags)
    return env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--link", choices=("static", "dynamic"), default="static")
    parser.add_argument("--native", type=Path)
    parser.add_argument("--race", action="store_true")
    parser.add_argument("--run", default=".")
    args = parser.parse_args()
    target = subprocess.check_output(["go", "env", "GOOS", "GOARCH"], text=True).split()
    native = args.native or PACKAGE / "Artifacts" / "-".join(target)
    subprocess.run(["go", "test", "-count=1", "-timeout=5m", *(["-race"] if args.race else []),
                    "-run", args.run, "./..."], cwd=PACKAGE, env=environment(native, args.link), check=True)


if __name__ == "__main__":
    main()
