#!/usr/bin/env python3
"""Prepare assets and build/run the detached WKWebView prototype with Xcode."""
import argparse
import json
import os
import plistlib
import shutil
import subprocess
import time
from pathlib import Path
from bundle_sdk import bundle, check

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
ARTIFACTS = ROOT / "Artifacts"
BUNDLE_ID = "io.wasmer.sdk.webkit-prototype"
MINIMUM_IOS = 27
SDKS = {"simulator": "iphonesimulator", "device": "iphoneos"}
ENV = {**os.environ, "DEVELOPER_DIR": os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")}
ENV["WASMER_SDK_LOCAL_WEB_RUNTIME"] = "1"


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], env=ENV, check=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(arg) for arg in args], env=ENV, text=True).strip()


def prepare(rebuild=False):
    if rebuild:
        run("npm", "run", "build:wasm", cwd=REPO / "js")
    run("npm", "run", "build:ts", cwd=REPO / "js")
    bundle()


def build_package(platform, scratch):
    """Build the repository's public SwiftPM product, including its resources."""
    sdk = SDKS[platform]
    target = {"simulator": "arm64-apple-ios27.0-simulator", "device": "arm64-apple-ios27.0"}[platform]
    options = ["--package-path", REPO, "--scratch-path", scratch, "--configuration", "release",
               "--triple", target, "--sdk", output("xcrun", "--sdk", sdk, "--show-sdk-path")]
    run("xcrun", "swift", "build", *options, "--product", "WasmerSDK")
    return Path(output("xcrun", "swift", "build", *options, "--show-bin-path"))


def copy_resources(library, destination):
    for bundle_path in library.glob("*.bundle"):
        target = destination / bundle_path.name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(bundle_path, target)


def build(platform):
    sdk = SDKS[platform]
    target = {"simulator": "arm64-apple-ios27.0-simulator", "device": "arm64-apple-ios27.0"}[platform]
    app = ARTIFACTS / platform / "WasmerWKSDKProbe.app"
    resources = app
    executable = app / "WasmerWKSDKProbe"
    executable.parent.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    library = build_package(platform, ROOT / ".build/package")
    main = ROOT / "Demo/iOSApp.swift"
    run("xcrun", "--sdk", sdk, "swiftc", "-swift-version", "6", "-parse-as-library", "-target", target,
        "-sdk", output("xcrun", "--sdk", sdk, "--show-sdk-path"), "-O", "-I", library, "-I", library / "Modules",
        ROOT / "Demo/Probe.swift", REPO / "swift/Tests/WasmerSDKTests/SDKContract.swift", main, library / "libWasmerSDK.a", "-o", executable)
    copy_resources(library, resources)
    shutil.copyfile(ROOT / "Demo/python-smoke.py", resources / "python-smoke.py")
    shutil.copytree(REPO / "swift/Tests/WasmerSDKTests/Fixtures", resources / "Fixtures", dirs_exist_ok=True)
    info = {
        "CFBundleIdentifier": BUNDLE_ID, "CFBundleExecutable": "WasmerWKSDKProbe",
        "CFBundleName": "WasmerWKSDK Probe", "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    }
    info.update(MinimumOSVersion="27.0", UIDeviceFamily=[1, 2], UILaunchScreen={},
                    UIApplicationSceneManifest={"UIApplicationSupportsMultipleScenes": False})
    with (app / "Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    run("codesign", "--force", "--sign", "-", app)
    return app


def select_simulator(devices, device=None):
    candidates = []
    for runtime, entries in devices["devices"].items():
        if ".iOS-" not in runtime:
            continue
        version = runtime.split(".iOS-", 1)[1]
        if int(version.split("-", 1)[0]) >= MINIMUM_IOS:
            candidates.extend({**d, "runtime": runtime} for d in entries if d.get("isAvailable", True))
    selected = next((d for d in candidates if d["udid"] == device), None) if device else next((d for d in candidates if d["state"] == "Booted"), candidates[0] if candidates else None)
    if selected is None:
        raise SystemExit("An available iOS 27+ simulator is required for Python/JSPI; install one in Xcode or select it with --device")
    return selected


def simulator_run(app, selected):
    device = selected["udid"]
    if selected["state"] != "Booted":
        run("xcrun", "simctl", "boot", device)
    run("xcrun", "simctl", "bootstatus", device, "-b")
    run("xcrun", "simctl", "install", device, app)
    container = Path(output("xcrun", "simctl", "get_app_container", device, BUNDLE_ID, "data"))
    result = container / "Documents/prototype-result.json"
    progress = container / "Documents/prototype-progress.txt"
    result.unlink(missing_ok=True)
    progress.unlink(missing_ok=True)
    run("xcrun", "simctl", "launch", "--terminate-running-process", device, BUNDLE_ID)
    deadline = time.monotonic() + 660
    previous = ""
    while not result.exists() and time.monotonic() < deadline:
        if progress.exists():
            current = progress.read_text()
            if current != previous:
                print(current[len(previous):].strip(), flush=True)
                previous = current
        time.sleep(1)
    if not result.exists():
        raise SystemExit("Prototype timed out; inspect the app or simulator logs")
    report = json.loads(result.read_text())
    report["simulator"] = {key: selected[key] for key in ("name", "udid", "runtime")}
    (ARTIFACTS / "simulator-result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "build", "run"])
    parser.add_argument("--platform", choices=["simulator", "device"], default="simulator")
    parser.add_argument("--device", help="Simulator UDID")
    parser.add_argument("--rebuild-wasm", action="store_true")
    args = parser.parse_args()
    selected = None
    if args.action != "prepare":
        version = output("xcrun", "--sdk", SDKS[args.platform], "--show-sdk-version")
        if int(version.split(".", 1)[0]) < MINIMUM_IOS:
            raise SystemExit(f"iOS 27+ SDK required (found {version}); point DEVELOPER_DIR at Xcode 27")
        if args.action == "run" and args.platform == "simulator":
            selected = select_simulator(json.loads(output("xcrun", "simctl", "list", "devices", "available", "--json")), args.device)
    if args.action == "prepare" or args.rebuild_wasm:
        prepare(args.rebuild_wasm)
    else:
        check()
    if args.action == "prepare":
        return
    app = build(args.platform)
    print(f"Built {app}", flush=True)
    if args.action == "run":
        if args.platform == "simulator":
            simulator_run(app, selected)
        else:
            raise SystemExit("Device builds need development signing before installation; use the Swift package in an Xcode iOS app")


if __name__ == "__main__":
    main()
