#!/usr/bin/env python3
"""Build, run, or smoke-test the native Ghostty terminal on iOS 27+."""
import argparse
import json
import plistlib
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SDK = ROOT.parents[1] / "WasmerWKSDK"
sys.path.insert(0, str(SDK / "scripts"))
from prototype import run, output, build_package, copy_resources, select_simulator, SDKS, ENV
from bundle_sdk import check

REVISION = "5de703a1b6ca0b91fcebe932b44be1df2de0a683"
BUNDLE_ID = "io.wasmer.sdk.ios-terminal"
ARTIFACTS = ROOT / "Artifacts"


def ghostty(platform):
    zig = shutil.which("zig")
    if not zig or output(zig, "version") != "0.16.0":
        raise SystemExit("Install Zig 0.16.0 and make zig available on PATH")
    source = ROOT / ".build/ghostty"
    prefix = ROOT / f".build/ghostty-{platform}"
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--no-checkout", "https://github.com/ghostty-org/ghostty.git", source)
    if not (source / "build.zig").exists() or output("git", "-C", source, "rev-parse", "HEAD") != REVISION:
        run("git", "-C", source, "fetch", "origin", REVISION)
        run("git", "-C", source, "checkout", "--detach", REVISION)
    target = "aarch64-ios-simulator" if platform == "simulator" else "aarch64-ios"
    run(zig, "build", "-Demit-lib-vt=true", "-Demit-xcframework=false",
        f"-Dtarget={target}", "-Doptimize=ReleaseFast", "--prefix", prefix, cwd=source)
    return prefix


def build(platform, edgejs_webc=None, integration_tests=False):
    sdk = SDKS[platform]
    if int(output("xcrun", "--sdk", sdk, "--show-sdk-version").split(".")[0]) < 27:
        raise SystemExit("Xcode 27+ is required; set DEVELOPER_DIR to its Contents/Developer")
    prefix = ghostty(platform)
    check()
    library = build_package(platform, ROOT / ".build/package")
    app = ARTIFACTS / platform / "WasmerShell.app"
    app.mkdir(parents=True, exist_ok=True)
    target = "arm64-apple-ios27.0" + ("-simulator" if platform == "simulator" else "")
    sdk_path = output("xcrun", "--sdk", sdk, "--show-sdk-path")
    obj = app.parent / "GhosttyBridge.o"
    run("xcrun", "--sdk", sdk, "clang", "-target", target, "-isysroot", sdk_path,
        "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", prefix / "include",
        "-c", ROOT / "GhosttyBridge.c", "-o", obj)
    sources = sorted(ROOT.glob("*.swift"))
    test_options = []
    if integration_tests:
        sources.extend(sorted((ROOT / "Tests").glob("*.swift")))
        test_options = ["-D", "WASMER_SHELL_TESTS"]
    run("xcrun", "--sdk", sdk, "swiftc", "-swift-version", "6", "-parse-as-library", *test_options,
        "-target", target, "-sdk", sdk_path, "-O", "-import-objc-header", ROOT / "GhosttyBridge.h",
        "-I", library, "-I", library / "Modules", *sources, obj, library / "libWasmerSDK.a",
        prefix / "lib/libghostty-vt.a", "-o", app / "WasmerShell")
    copy_resources(library, app)
    # Test runtime changes before publishing a registry release. This artifact
    # is generated externally and never checked into the source tree.
    local_edgejs = app / "edgejs.webc"
    if edgejs_webc:
        shutil.copyfile(edgejs_webc, local_edgejs)
    else:
        local_edgejs.unlink(missing_ok=True)
    examples = app / "Examples"
    examples.mkdir(exist_ok=True)
    # Bundle the same examples and requirements as wasmer.sh, without drift.
    for source_name, name in (("node", "node"), ("next", "node-next"),
                              ("python", "python"), ("python-django", "python-django"),
                              ("python-fastapi", "python-fastapi")):
        destination = examples / name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(ROOT.parents[2] / "wasmer-sh/workspace" / source_name, destination,
                        ignore=shutil.ignore_patterns("node_modules", ".next"))
        readme = destination / "README.md"
        instructions = readme.read_text().replace(f"/workspace/{source_name}", f"/workspace/{name}")
        readme.write_text(instructions)
    shutil.copyfile(ROOT / ".build/ghostty/LICENSE", app / "Ghostty-LICENSE.txt")
    info = dict(CFBundleIdentifier=BUNDLE_ID, CFBundleExecutable="WasmerShell",
                CFBundleName="WasmerShell", CFBundleDisplayName="WasmerShell",
                CFBundlePackageType="APPL", CFBundleShortVersionString="0.1.0", CFBundleVersion="1",
                MinimumOSVersion="27.0", UIDeviceFamily=[1, 2], UILaunchScreen={},
                UIApplicationSceneManifest={"UIApplicationSupportsMultipleScenes": False},
                NSAppTransportSecurity={"NSAllowsLocalNetworking": True})
    with (app / "Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    run("codesign", "--force", "--sign", "-", app)
    print(f"Built {app}", flush=True)
    return app


def launch(app, selected, smoke, example=None, stress=False, quick=False, storage=None, reuse_next_project=False, next_runs=3):
    device = selected["udid"]
    if selected["state"] != "Booted":
        run("xcrun", "simctl", "boot", device)
    run("xcrun", "simctl", "bootstatus", device, "-b")
    run("xcrun", "simctl", "install", device, app)
    container = Path(output("xcrun", "simctl", "get_app_container", device, BUNDLE_ID, "data"))
    result = container / "Documents/terminal-result.json"
    result.unlink(missing_ok=True)
    progress = container / "Documents/terminal-progress.txt"
    progress.unlink(missing_ok=True)
    arguments = (["--stress-test"] + (["--stress-quick"] if quick else []) if stress
                 else ["--smoke-test"] if smoke else [])
    if storage or smoke:
        arguments.extend(["--storage", storage or "native"])
    if example:
        arguments.append("--example-" + example)
    if reuse_next_project:
        arguments.append("--reuse-next-project")
    if example == "node-next":
        arguments.extend(["--next-runs", str(next_runs)])
    run("xcrun", "simctl", "launch", "--terminate-running-process", device, BUNDLE_ID, *arguments)
    if not smoke:
        developer = Path(ENV["DEVELOPER_DIR"])
        # Xcode 27 moved the simulator UI into Device Hub.
        interfaces = [developer.parent / "Applications/DeviceHub.app",
                      developer / "Applications/Simulator.app"]
        interface = next((path for path in interfaces if path.exists()), None)
        if interface:
            run("open", interface)
        else:
            print("App launched. Open the selected simulator in Xcode.", flush=True)
        return
    deadline = time.monotonic() + (1200 if stress else 600 + 180 * next_runs if example == "node-next" else 420)
    previous = ""
    while not result.exists() and time.monotonic() < deadline:
        if progress.exists():
            current = progress.read_text()
            if current != previous:
                print(current, flush=True)
                previous = current
        time.sleep(1)
    if not result.exists():
        raise SystemExit("Terminal timed out; inspect the simulator and its logs")
    report = json.loads(result.read_text())
    report["simulator"] = {key: selected[key] for key in ("name", "udid", "runtime")}
    (ARTIFACTS / ("terminal-stress-result.json" if stress else "terminal-result.json")).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "run", "test", "stress"])
    parser.add_argument("--platform", choices=["simulator", "device"], default="simulator")
    parser.add_argument("--device", help="iOS 27+ simulator UDID")
    parser.add_argument("--example", choices=["node", "node-next", "python", "storage"], help="Start a server (run), or select the node-next/storage integration test (test)")
    parser.add_argument("--edgejs-webc", type=Path, help="Use a locally generated EdgeJS package instead of the registry release")
    parser.add_argument("--storage", choices=["native", "memory", "opfs"], help="Choose workspace storage; run preserves the app selection, tests default to native")
    parser.add_argument("--reuse-next-project", action="store_true", help="Test the existing node-next directory and pnpm cache, preserving files (test --example node-next only)")
    parser.add_argument("--next-runs", type=int, choices=range(1, 21), default=3, help="Next.js start/page/API/stop cycles in one session (default: 3)")
    parser.add_argument("--quick", action="store_true", help="Stress 100 child processes without package installs (stress only)")
    args = parser.parse_args()
    if args.reuse_next_project and (args.action != "test" or args.example != "node-next"):
        parser.error("--reuse-next-project requires test --example node-next")
    selected = None
    if args.action != "build":
        if args.platform != "simulator":
            raise SystemExit("Physical installation requires development signing; use build --platform device")
        selected = select_simulator(json.loads(output("xcrun", "simctl", "list", "devices", "available", "--json")), args.device)
    app = build(args.platform, args.edgejs_webc, integration_tests=args.action in ("test", "stress"))
    if selected:
        launch(app, selected, args.action in ("test", "stress"), args.example, args.action == "stress", args.quick, args.storage, args.reuse_next_project, args.next_runs)


if __name__ == "__main__":
    main()
