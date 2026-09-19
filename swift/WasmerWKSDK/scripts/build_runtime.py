#!/usr/bin/env python3
"""Package generated JS/Wasm in a resource-carrying dynamic XCFramework.

SwiftPM downloads and Xcode embeds this framework, keeping generated assets out
of the source repository and avoiding downloads or compilation at app runtime.
"""
import plistlib
import shutil
import subprocess
from pathlib import Path
from bundle_sdk import ROOT, REPO, check

NAME = "WasmerWKRuntime"
ARTIFACTS = REPO / "swift/Artifacts"


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def build():
    check()
    scratch = ROOT / ".build/runtime"
    shutil.rmtree(scratch, ignore_errors=True)
    frameworks = []
    # Only Foundation is used by the resource accessor. The build does not need
    # the iOS 27 SDK or simulator; execution of the WebKit backend does.
    for sdk, target, architectures, minimum in (
        ("iphoneos", "apple-ios27.0", ["arm64"], "27.0"),
        ("iphonesimulator", "apple-ios27.0-simulator", ["arm64", "x86_64"], "27.0"),
        ("macosx", "apple-macos12.0", ["arm64", "x86_64"], "12.0"),
    ):
        framework = scratch / sdk / f"{NAME}.framework"
        # macOS frameworks are versioned bundles; iOS frameworks are flat.
        content = framework / "Versions/A" if sdk == "macosx" else framework
        resources = content / "Resources" if sdk == "macosx" else content
        for directory in (content / "Headers", content / "Modules", resources):
            directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / f"Runtime/{NAME}.h", content / f"Headers/{NAME}.h")
        (content / "Modules/module.modulemap").write_text(
            f'framework module {NAME} {{ umbrella header "{NAME}.h"\n export *\n}}\n')
        shutil.copytree(ROOT / "Sources/WasmerWKSDK/Web", resources / "Web")
        info = dict(CFBundleIdentifier="io.wasmer.sdk.webkit-runtime", CFBundleName=NAME,
                    CFBundleExecutable=NAME, CFBundlePackageType="FMWK",
                    CFBundleShortVersionString=(REPO / "swift/version.txt").read_text().strip(),
                    CFBundleVersion="1")
        info["LSMinimumSystemVersion" if sdk == "macosx" else "MinimumOSVersion"] = minimum
        (resources / "Info.plist").write_bytes(plistlib.dumps(info))
        binaries = []
        sdk_path = subprocess.check_output(
            ["xcrun", "--sdk", sdk, "--show-sdk-path"], text=True).strip()
        install_path = f"{NAME}.framework/" + ("Versions/A/" if sdk == "macosx" else "") + NAME
        for architecture in architectures:
            binary = scratch / sdk / architecture
            run("xcrun", "--sdk", sdk, "clang", "-target", f"{architecture}-{target}",
                "-isysroot", sdk_path, "-dynamiclib", "-fobjc-arc", "-O2",
                "-framework", "Foundation", "-install_name", f"@rpath/{install_path}",
                ROOT / f"Runtime/{NAME}.m", "-o", binary)
            binaries.append(binary)
        run("xcrun", "lipo", "-create", *binaries, "-output", content / NAME)
        if sdk == "macosx":
            (framework / "Versions/Current").symlink_to("A")
            for name in (NAME, "Headers", "Modules", "Resources"):
                (framework / name).symlink_to(f"Versions/Current/{name}")
        frameworks.extend(["-framework", framework])
    destination = ARTIFACTS / f"{NAME}.xcframework"
    shutil.rmtree(destination, ignore_errors=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    run("xcodebuild", "-create-xcframework", *frameworks, "-output", destination)
    print(f"Built {destination}", flush=True)


if __name__ == "__main__":
    build()
