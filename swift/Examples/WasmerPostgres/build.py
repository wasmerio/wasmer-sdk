#!/usr/bin/env python3
"""Build and run the Swift PostgreSQL console on an iOS 27+ simulator."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
sys.path.insert(0, str(REPO / "swift/WasmerWKSDK/scripts"))
from bundle_sdk import check
from prototype import select_simulator

ENV = {**os.environ, "DEVELOPER_DIR": os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer"),
       "WASMER_SDK_LOCAL_WEB_RUNTIME": "1"}
BUNDLE_ID = "io.wasmer.sdk.postgres"


def run(*args):
    subprocess.run([str(a) for a in args], env=ENV, check=True)


def output(*args):
    return subprocess.check_output([str(a) for a in args], env=ENV, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Simulator UDID (defaults to a booted iOS 27+ simulator)")
    parser.add_argument("--test", action="store_true", help="Run the Swift client integration checks")
    parser.add_argument("--pglite-webc", type=Path, help="Test a locally rebuilt PostgreSQL package")
    args = parser.parse_args()
    if args.pglite_webc and not args.pglite_webc.is_file():
        parser.error("--pglite-webc must point to an existing package")
    check()
    device = select_simulator(json.loads(output("xcrun", "simctl", "list", "devices", "available", "--json")), args.device)
    udid = device["udid"]
    if device["state"] != "Booted":
        run("xcrun", "simctl", "boot", udid)
    run("xcrun", "simctl", "bootstatus", udid, "-b")
    run("xcodegen", "generate", "--spec", ROOT / "project.yml")
    run("xcodebuild", "-project", ROOT / "WasmerPostgres.xcodeproj", "-scheme", "WasmerPostgres",
        "-configuration", "Debug", "-destination", f"platform=iOS Simulator,id={udid}",
        "-derivedDataPath", ROOT / ".build/DerivedData",
        "-clonedSourcePackagesDirPath", ROOT / ".build/SourcePackages", "CODE_SIGNING_ALLOWED=NO", "build")
    app = ROOT / ".build/DerivedData/Build/Products/Debug-iphonesimulator/WasmerPostgres.app"
    local = app / "pglite.webc"
    if args.pglite_webc:
        shutil.copyfile(args.pglite_webc, local)
    else:
        local.unlink(missing_ok=True)
    run("codesign", "--force", "--sign", "-", app)
    run("xcrun", "simctl", "install", udid, app)
    container = Path(output("xcrun", "simctl", "get_app_container", udid, BUNDLE_ID, "data"))
    result = container / "Documents/test-result.json"
    result.unlink(missing_ok=True)
    run("xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID,
        *(["--self-test"] if args.test else []))
    if args.test:
        deadline = time.monotonic() + 300
        while not result.exists() and time.monotonic() < deadline:
            time.sleep(1)
        if not result.exists():
            raise SystemExit(f"Timed out; inspect {container / 'Documents/postgres.log'}")
        value = json.loads(result.read_text())
        print(json.dumps(value, indent=2))
        raise SystemExit(0 if value["passed"] else 1)
    print(f"Launched Wasmer Postgres on {device['name']}")


if __name__ == "__main__":
    main()
