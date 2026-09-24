#!/usr/bin/env python3
"""Run Go tests against the local static or dynamic SDK archive."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from common import PACKAGE, environment


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
