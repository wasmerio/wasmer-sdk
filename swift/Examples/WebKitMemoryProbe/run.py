#!/usr/bin/env python3
"""Build and run the engine-only probe on an explicitly selected iOS simulator."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import threading
import time
import urllib.parse

ROOT = Path(__file__).resolve().parent
BUNDLE = "io.wasmer.memory-probe"


class Assets(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="Dedicated iOS 27+ simulator UDID")
    parser.add_argument("--mode", choices=["shared", "local"], default="shared")
    parser.add_argument("--workers", type=int, default=20, choices=range(1, 65), metavar="1..64")
    parser.add_argument("--iterations", type=int, default=2000)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--delay-ms", type=float, default=0)
    parser.add_argument("--recycle-every", type=int, default=0)
    args = parser.parse_args()
    if args.iterations < 1 or args.timeout <= 0 or args.delay_ms < 0 or args.recycle_every < 0:
        parser.error("iterations/timeout must be positive and delay/recycle must be nonnegative")
    env = {**os.environ}
    env.setdefault("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")

    def run(*command, capture=False):
        result = subprocess.run([str(arg) for arg in command], check=True, env=env,
                                text=True, stdout=subprocess.PIPE if capture else None)
        return result.stdout.strip() if capture else None

    app = ROOT / ".build/MemoryProbe.app"
    app.mkdir(parents=True, exist_ok=True)
    sdk = run("xcrun", "--sdk", "iphonesimulator", "--show-sdk-path", capture=True)
    run("xcrun", "--sdk", "iphonesimulator", "swiftc", "-swift-version", "6",
        "-parse-as-library", "-target", f"{platform.machine()}-apple-ios27.0-simulator",
        "-sdk", sdk, "-O", ROOT / "Probe.swift", "-o", app / "MemoryProbe")
    with (app / "Info.plist").open("wb") as file:
        plistlib.dump(dict(CFBundleIdentifier=BUNDLE, CFBundleExecutable="MemoryProbe",
            CFBundleName="MemoryProbe", CFBundlePackageType="APPL", CFBundleVersion="1",
            CFBundleShortVersionString="1.0", MinimumOSVersion="27.0", UIDeviceFamily=[1, 2],
            UILaunchScreen={}, UIApplicationSceneManifest={"UIApplicationSupportsMultipleScenes": False},
            NSAppTransportSecurity={"NSAllowsLocalNetworking": True}), file)
    run("codesign", "--force", "--sign", "-", app)
    run("xcrun", "simctl", "bootstatus", args.device, "-b")
    run("xcrun", "simctl", "install", args.device, app)
    # Only this diagnostic app is restarted. WasmerShell and its data are untouched.
    subprocess.run(["xcrun", "simctl", "terminate", args.device, BUNDLE], env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    container = Path(run("xcrun", "simctl", "get_app_container", args.device, BUNDLE, "data", capture=True))
    result_path = container / "Documents/result.json"
    result_path.unlink(missing_ok=True)
    (container / "Documents/progress.json").unlink(missing_ok=True)
    handler = functools.partial(Assets, directory=str(ROOT / "Web"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    query = urllib.parse.urlencode(dict(mode=args.mode, workers=args.workers,
                                       iterations=args.iterations, delayMs=args.delay_ms,
                                       recycleEvery=args.recycle_every))
    url = f"http://127.0.0.1:{server.server_port}/index.html?{query}"
    try:
        run("xcrun", "simctl", "launch", args.device, BUNDLE, "--url", url)
        deadline = time.monotonic() + args.timeout
        while not result_path.exists():
            if time.monotonic() > deadline:
                raise TimeoutError(f"No final result; inspect {container / 'Documents/progress.json'}")
            time.sleep(0.25)
        result = json.loads(result_path.read_text())
        artifacts = ROOT / "Artifacts"
        artifacts.mkdir(exist_ok=True)
        destination = artifacts / f"ios-{args.mode}-{args.workers}-delay{args.delay_ms:g}-recycle{args.recycle_every}.json"
        shutil.copyfile(result_path, destination)
        print(json.dumps(result, indent=2))
        print(f"Saved {destination}")
        return 0 if result.get("passed") else 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
