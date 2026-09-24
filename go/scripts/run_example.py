#!/usr/bin/env python3
"""Run a Go example against the local static or dynamic SDK archive."""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from common import PACKAGE, environment


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--link", choices=("static", "dynamic"), default="static")
    parser.add_argument("--native", type=Path)
    parser.add_argument("example", choices=("python", "multiple_runtimes", "edgejs_http", "postgres_psql"))
    parser.add_argument("args", nargs=argparse.REMAINDER, help="arguments passed to the example")
    args = parser.parse_args()
    target = subprocess.check_output(["go", "env", "GOOS", "GOARCH"], text=True).split()
    native = args.native or PACKAGE / "Artifacts" / "-".join(target)
    if args.example in {"edgejs_http", "multiple_runtimes"}:
        if json.loads((native / "native.json").read_text())["backend"] != "napi-v8":
            parser.error("this example requires a napi-v8 native build (macOS arm64 or Linux amd64)")
    subprocess.run(["go", "run", "./examples/" + args.example, *args.args],
                   cwd=PACKAGE, env=environment(native, args.link), check=True)


if __name__ == "__main__":
    main()
