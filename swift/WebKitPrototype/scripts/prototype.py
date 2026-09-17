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

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
ARTIFACTS = ROOT / "Artifacts"
BUNDLE_ID = "io.wasmer.sdk.webkit-prototype"
MINIMUM_IOS = 27
SDKS = {"simulator": "iphonesimulator", "device": "iphoneos", "macos": "macosx"}
ENV = {**os.environ, "DEVELOPER_DIR": os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")}


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], env=ENV, check=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(arg) for arg in args], env=ENV, text=True).strip()


def prepare(rebuild=False):
    if rebuild:
        run("npm", "run", "build:wasm", cwd=REPO / "js")
    run("npm", "run", "build:ts", cwd=REPO / "js")
    assets = ROOT / "Sources/WasmerWebKit/Web/sdk"
    for name in ("dist", "pkg"):
        destination = assets / name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(REPO / "js" / name, destination)


def build(platform):
    sdk = SDKS[platform]
    target = {"simulator": "arm64-apple-ios27.0-simulator", "device": "arm64-apple-ios27.0", "macos": "arm64-apple-macos14.0"}[platform]
    app = ARTIFACTS / platform / "WasmerWebKitPrototype.app"
    resources = app / "Contents/Resources" if platform == "macos" else app
    executable = app / "Contents/MacOS/WasmerWebKitPrototype" if platform == "macos" else app / "WasmerWebKitPrototype"
    executable.parent.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    sources = sorted((ROOT / "Sources/WasmerWebKit").glob("*.swift"))
    main = ROOT / "Demo" / ("macOSMain.swift" if platform == "macos" else "iOSApp.swift")
    run("xcrun", "--sdk", sdk, "swiftc", "-swift-version", "6", "-parse-as-library", "-target", target,
        "-sdk", output("xcrun", "--sdk", sdk, "--show-sdk-path"), "-O", *sources,
        ROOT / "Demo/Probe.swift", main, "-o", executable)
    destination = resources / "Web"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(ROOT / "Sources/WasmerWebKit/Web", destination)
    info = {
        "CFBundleIdentifier": BUNDLE_ID, "CFBundleExecutable": "WasmerWebKitPrototype",
        "CFBundleName": "Wasmer WebKit Prototype", "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    }
    if platform == "macos":
        info.update(LSMinimumSystemVersion="14.0", LSUIElement=True)
    else:
        info.update(MinimumOSVersion="27.0", UIDeviceFamily=[1, 2], UILaunchScreen={},
                    UIApplicationSceneManifest={"UIApplicationSupportsMultipleScenes": False})
    with (app / "Contents/Info.plist" if platform == "macos" else app / "Info.plist").open("wb") as stream:
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
    parser.add_argument("--platform", choices=["simulator", "device", "macos"], default="simulator")
    parser.add_argument("--device", help="Simulator UDID")
    parser.add_argument("--rebuild-wasm", action="store_true")
    args = parser.parse_args()
    selected = None
    if args.action != "prepare" and args.platform != "macos":
        version = output("xcrun", "--sdk", SDKS[args.platform], "--show-sdk-version")
        if int(version.split(".", 1)[0]) < MINIMUM_IOS:
            raise SystemExit(f"iOS 27+ SDK required (found {version}); point DEVELOPER_DIR at Xcode 27")
        if args.action == "run" and args.platform == "simulator":
            selected = select_simulator(json.loads(output("xcrun", "simctl", "list", "devices", "available", "--json")), args.device)
    prepare(args.rebuild_wasm)
    if args.action == "prepare":
        return
    app = build(args.platform)
    print(f"Built {app}", flush=True)
    if args.action == "run":
        if args.platform == "simulator":
            simulator_run(app, selected)
        elif args.platform == "macos":
            run(app / "Contents/MacOS/WasmerWebKitPrototype")
        else:
            raise SystemExit("Device builds need development signing before installation; use the Swift package in an Xcode iOS app")


if __name__ == "__main__":
    main()
