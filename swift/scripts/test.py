#!/usr/bin/env python3
"""Run Swift Testing, selecting an installed Xcode without changing system settings."""
from pathlib import Path
import os
import subprocess
import sys

package = Path(__file__).resolve().parents[1]
developer = Path(subprocess.check_output(["xcode-select", "-p"], text=True).strip())
environment = os.environ.copy()
if "DEVELOPER_DIR" not in environment and developer.name == "CommandLineTools":
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if not xcode.is_dir():
        raise SystemExit("Tests require full Xcode. Set DEVELOPER_DIR to its Contents/Developer directory.")
    # CLT distributions can lack the Testing interop runtime or framework paths.
    environment["DEVELOPER_DIR"] = str(xcode)
command = ["xcrun", "swift", "test", "--package-path", str(package), "--disable-xctest"]
command += sys.argv[1:]
print("+", " ".join(command), flush=True)
subprocess.run(command, env=environment, check=True)
