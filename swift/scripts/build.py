#!/usr/bin/env python3
"""Build the Rust library, generate Swift, and assemble a local XCFramework."""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
WORKSPACE = PACKAGE.parent
LIBRARY = "libwasmer_sdk_uniffi.a"
# Keep Rust and all native C/assembly dependencies aligned with Package.swift.
BUILD_ENV = {
    **os.environ,
    "MACOSX_DEPLOYMENT_TARGET": "12.0",
    # blake3 tracks CFLAGS but suppresses cc's deployment-target change tracking.
    "CFLAGS": (os.environ.get("CFLAGS", "") + " -mmacosx-version-min=12.0").strip(),
}
SUPPORTED_TARGETS = {
    "aarch64-apple-darwin": "arm64",
    "x86_64-apple-darwin": "x86_64",
}


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=WORKSPACE, env=BUILD_ENV, check=True)


def output(command: list[str]) -> str:
    return subprocess.check_output(command, cwd=WORKSPACE, env=BUILD_ENV, text=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    parser.add_argument(
        "--target", action="append", dest="targets",
        help="Rust Apple target (repeat for a universal macOS library; default: host)",
    )
    args = parser.parse_args()
    if os.uname().sysname != "Darwin":
        parser.error("Swift native builds require macOS and the Apple command line tools")
    host = next(line[6:] for line in output(["rustc", "-vV"]).splitlines()
                if line.startswith("host: "))
    if os.environ.get("CARGO_BUILD_TARGET"):
        parser.error("unset CARGO_BUILD_TARGET and use --target; the binding generator must be built for the host")
    targets = list(dict.fromkeys(args.targets or [host]))
    for target in targets:
        if "apple-ios" in target:
            parser.error(
                "iOS is blocked by the pinned Wasmer runtime: Cranelift needs JIT, "
                "the V8 build has no iOS target, and no interpreter backend is available. "
                "See swift/README.md. No iOS artifact was produced."
            )
        if target not in SUPPORTED_TARGETS:
            parser.error(f"unsupported target: {target}")
    metadata = json.loads(output(["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"]))
    target_dir = Path(metadata["target_directory"])
    profile = "release" if args.release else "debug"
    release = ["--release"] if args.release else []
    features = ["--no-default-features", "--features", "sys,bindgen-cli"]
    # The generator must run on the host even when compiling another architecture.
    run(["cargo", "build", "--locked", "-p", "wasmer-sdk-uniffi", *features,
         "--lib", "--bin", "uniffi-bindgen", *release])
    libraries = []
    for target in targets:
        if target == host:
            libraries.append(target_dir / profile / LIBRARY)
        else:
            run(["cargo", "build", "--locked", "-p", "wasmer-sdk-uniffi",
                 "--no-default-features", "--features", "sys", "--lib",
                 "--target", target, *release])
            libraries.append(target_dir / target / profile / LIBRARY)
    for target, library in zip(targets, libraries):
        actual = output(["xcrun", "lipo", "-archs", str(library)]).split()
        if actual != [SUPPORTED_TARGETS[target]]:
            raise SystemExit(f"{library}: expected {SUPPORTED_TARGETS[target]}, found {actual}")

    artifacts = PACKAGE / "Artifacts"
    artifacts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".build-", dir=artifacts) as temporary:
        staging = Path(temporary)
        generated = staging / "generated"
        run([str(target_dir / profile / "uniffi-bindgen"), "generate", "--library",
             str(target_dir / profile / LIBRARY), "--language", "swift",
             "--out-dir", str(generated)])
        framework = staging / "WasmerSDKFFI.xcframework"
        architectures = sorted(SUPPORTED_TARGETS[target] for target in targets)
        identifier = "macos-" + "_".join(architectures)
        slice_dir = framework / identifier
        headers = slice_dir / "Headers"
        headers.mkdir(parents=True)
        shutil.copy2(generated / "WasmerSDKFFI.h", headers)
        shutil.copy2(generated / "WasmerSDKFFI.modulemap", headers / "module.modulemap")
        if len(libraries) == 1:
            shutil.copy2(libraries[0], slice_dir / LIBRARY)
        else:
            run(["xcrun", "lipo", "-create", *(str(lib) for lib in libraries),
                 "-output", str(slice_dir / LIBRARY)])
        # A static-library XCFramework is a bundle of archives, headers and this
        # manifest. Assembling it directly also works with Command Line Tools
        # installations, where xcodebuild -create-xcframework is unavailable.
        with (framework / "Info.plist").open("wb") as stream:
            plistlib.dump({
                "CFBundlePackageType": "XFWK",
                "XCFrameworkFormatVersion": "1.0",
                "AvailableLibraries": [{
                    "LibraryIdentifier": identifier,
                    "LibraryPath": LIBRARY,
                    "HeadersPath": "Headers",
                    "SupportedArchitectures": architectures,
                    "SupportedPlatform": "macos",
                }],
            }, stream)
        destination = artifacts / framework.name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(framework), destination)
        sources = PACKAGE / "Sources" / "WasmerSDKCore"
        sources.mkdir(parents=True, exist_ok=True)
        shutil.copy2(generated / "WasmerSDKCore.swift", sources)
    print(f"Built {destination}; run python3 {PACKAGE / 'scripts' / 'test.py'}")


if __name__ == "__main__":
    main()
