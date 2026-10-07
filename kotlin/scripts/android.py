#!/usr/bin/env python3
"""Build, install, run and test Wasmer Shell on an Android device or emulator."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from build import KOTLIN, ROOT, TARGETS, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "run", "test"])
    parser.add_argument("--abi", choices=TARGETS, default="arm64-v8a")
    parser.add_argument("--serial", help="adb device serial (required when multiple devices are connected)")
    parser.add_argument("--example", help="Shared example ID, e.g. python, node, clang; shell opens all runtimes")
    parser.add_argument("--integration", action="store_true", help="Run registry-backed Python, Node and Clang terminal tests")
    parser.add_argument("--skip-native", action="store_true", help="Reuse previously built Rust/Ghostty libraries")
    parser.add_argument("--debug-native", action="store_true", help="Build Rust without optimizations (slower guest compilation)")
    args = parser.parse_args()
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        parser.error("Set ANDROID_HOME to your Android SDK")
    if not args.skip_native:
        run(sys.executable, KOTLIN / "scripts/build.py", "--android", "--shell", "--abi", args.abi,
            *([] if args.debug_native else ["--release"]),
            *(["--no-node"] if args.abi == "x86_64" else []))
    env = dict(os.environ)
    if args.serial:
        env["ANDROID_SERIAL"] = args.serial
    gradle = KOTLIN / "gradlew"
    abi = f"-Pwasmer.abis={args.abi}"
    if args.action == "test":
        if args.integration and args.abi != "arm64-v8a":
            parser.error("The Node integration test requires the ARM64 V8 build")
        run(gradle, abi, ":android:connectedDebugAndroidTest", ":shell:connectedDebugAndroidTest",
            *(["-Pandroid.testInstrumentationRunnerArguments.integration=true"] if args.integration else []),
            cwd=KOTLIN, env=env)
    else:
        run(gradle, abi, ":android:assembleRelease", ":shell:assembleDebug", cwd=KOTLIN, env=env)
        if args.action == "run":
            adb = [Path(sdk) / "platform-tools/adb"]
            if args.serial:
                adb += ["-s", args.serial]
            devices = subprocess.check_output([str(adb[0]), "devices"], text=True).splitlines()[1:]
            if not args.serial and len([line for line in devices if line.endswith("\tdevice")]) != 1:
                parser.error("Connect one Android device, or select it with --serial")
            run(*adb, "install", "-r", KOTLIN / "shell/build/outputs/apk/debug/shell-debug.apk")
            run(*adb, "shell", "am", "start", "-S", "-n", "io.wasmer.shell/.MainActivity",
                *(["--es", "example", args.example] if args.example else []))


if __name__ == "__main__":
    main()
