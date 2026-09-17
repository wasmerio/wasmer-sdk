#!/usr/bin/env python3
"""Package the SwiftUI example as a locally signed, Hardened Runtime macOS app."""
import argparse
import plistlib
import shutil
import subprocess
from pathlib import Path

package = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--release", action="store_true")
args = parser.parse_args()
configuration = "release" if args.release else "debug"
build = ["xcrun", "swift", "build", "--package-path", str(package),
         "--configuration", configuration]
subprocess.run([*build, "--product", "WasmerDemo"], check=True)
binary_dir = Path(subprocess.check_output([*build, "--show-bin-path"], text=True).strip())
app = package / "Artifacts" / "WasmerDemo.app"
if app.exists():
    shutil.rmtree(app)
contents = app / "Contents"
executables = contents / "MacOS"
executables.mkdir(parents=True)
shutil.copy2(binary_dir / "WasmerDemo", executables / "WasmerDemo")
with (contents / "Info.plist").open("wb") as stream:
    plistlib.dump({
        "CFBundleIdentifier": "io.wasmer.sdk.swift.demo",
        "CFBundleName": "WasmerDemo",
        "CFBundleDisplayName": "Wasmer for Swift",
        "CFBundleExecutable": "WasmerDemo",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": (package / "version.txt").read_text().strip(),
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
    }, stream)
subprocess.run([
    "codesign", "--force", "--sign", "-", "--options", "runtime",
    "--entitlements", str(package / "Examples" / "WasmerDemo.entitlements"), str(app),
], check=True)
print(f"Built {app}")
