#!/usr/bin/env python3
"""Build matching UniFFI Kotlin bindings and native JVM / Android libraries."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
KOTLIN = ROOT / "kotlin"
GHOSTTY_REVISION = "5de703a1b6ca0b91fcebe932b44be1df2de0a683"
TARGETS = {"arm64-v8a": ("aarch64-linux-android", "aarch64"), "x86_64": ("x86_64-linux-android", "x86_64")}


def run(*args, cwd=ROOT, env=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def ndk_path():
    if os.environ.get("ANDROID_NDK_HOME"):
        return Path(os.environ["ANDROID_NDK_HOME"])
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise SystemExit("Set ANDROID_HOME and install NDK 28.2.13676358, or set ANDROID_NDK_HOME")
    return Path(sdk) / "ndk/28.2.13676358"


def android_env(abi):
    ndk = ndk_path()
    host = "darwin-x86_64" if sys.platform == "darwin" else "linux-x86_64"
    toolchain = ndk / "toolchains/llvm/prebuilt" / host
    target, _ = TARGETS[abi]
    cc = toolchain / "bin" / f"{target}28-clang"
    if not cc.exists():
        raise SystemExit(f"Android NDK compiler not found: {cc}")
    # The pinned wasmer-napi build script emits Linux library names on Android.
    # Bionic supplies pthread/rt in libc; Android uses libc++, not GNU libstdc++.
    # Filter only those three flags, leaving all other Cargo arguments intact.
    wrapper = ROOT / ".build" / f"android-linker-{abi}.py"
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text(
        f"#!{sys.executable}\nimport os, sys\n"
        f"cc = {str(cc)!r}\n"
        "args = [arg for arg in sys.argv[1:] if arg not in ('-lpthread', '-lrt', '-lstdc++')]\n"
        "os.execv(cc, [cc, *args, '-lc++_shared', '-Wl,-z,max-page-size=16384'])\n"
    )
    wrapper.chmod(0o755)
    key = target.replace("-", "_")
    env = dict(os.environ)
    env.update({f"CC_{key}": str(cc), f"CXX_{key}": str(cc) + "++",
                f"AR_{key}": str(toolchain / "bin/llvm-ar"),
                f"CARGO_TARGET_{key.upper()}_LINKER": str(wrapper),
                f"CARGO_TARGET_{key.upper()}_RUSTFLAGS":
                    "-C link-arg=" + subprocess.check_output([str(cc), "-print-libgcc-file-name"], text=True).strip() +
                    " -C link-arg=-Wl,--no-undefined",
                "CARGO_PROFILE_DEV_DEBUG": "0", "CARGO_PROFILE_RELEASE_DEBUG": "0"})
    return env, toolchain


def ghostty(abi, toolchain):
    if subprocess.check_output(["zig", "version"], text=True).strip() != "0.16.0":
        raise SystemExit("Ghostty requires Zig 0.16.0")
    source = ROOT / ".build/ghostty"
    if not source.exists():
        run("git", "clone", "--no-checkout", "https://github.com/ghostty-org/ghostty.git", source)
    if subprocess.run(["git", "-C", str(source), "cat-file", "-e", GHOSTTY_REVISION],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run("git", "-C", source, "fetch", "origin", GHOSTTY_REVISION)
    run("git", "-C", source, "checkout", "--detach", GHOSTTY_REVISION)
    # Zig's global --libc also applies to native Unicode/code generators. Scope
    # the NDK libc to the VT target libraries so cross-compilation works on macOS.
    build_file = source / "src/build/GhosttyLibVt.zig"
    original = subprocess.check_output(["git", "-C", str(source), "show",
        f"{GHOSTTY_REVISION}:src/build/GhosttyLibVt.zig"], text=True)
    marker = "    if (lib.rootModuleTarget().abi.isAndroid()) {\n"
    if original.count(marker) != 1:
        raise SystemExit("Pinned Ghostty Android build hook changed")
    libc = ROOT / ".build" / f"android-libc-{abi}.txt"
    build_file.write_text(original.replace(marker, marker +
        '        lib.setLibCFile(.{ .cwd_relative = ' + json.dumps(str(libc)) + ' });\n'))
    prefix = ROOT / ".build" / f"ghostty-{abi}"
    target, arch = TARGETS[abi]
    libc = ROOT / ".build" / f"android-libc-{abi}.txt"
    sysroot = toolchain / "sysroot"
    libc.write_text(f"include_dir={sysroot}/usr/include\nsys_include_dir={sysroot}/usr/include/{target}\n"
                    f"crt_dir={sysroot}/usr/lib/{target}/28\nmsvc_lib_dir=\nkernel32_lib_dir=\ngcc_dir=\n")
    run("zig", "build", "-Demit-lib-vt=true", "-Demit-xcframework=false", "-Dsimd=false",
        f"-Dtarget={arch}-linux-android.28", "-Doptimize=ReleaseFast",
        "--prefix", prefix, cwd=source)
    return prefix


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android", action="store_true")
    parser.add_argument("--abi", action="append", choices=TARGETS)
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--no-node", action="store_true", help="Use Cranelift without Node-API/V8 (required for x86_64 Android)")
    parser.add_argument("--shell", action="store_true", help="Also build the libghostty-vt terminal bridge")
    args = parser.parse_args()
    if os.environ.get("CARGO_BUILD_TARGET"):
        parser.error("Unset CARGO_BUILD_TARGET; the generator must run on the host")
    abis = list(dict.fromkeys(args.abi or ["arm64-v8a"]))
    if args.android and "x86_64" in abis and not args.no_node:
        parser.error("V8's pinned Android binary is ARM64 only; use --no-node for x86_64")
    env = {**os.environ, "CARGO_PROFILE_DEV_DEBUG": "0"}
    # Host metadata has the same UniFFI interface regardless of runtime backend.
    run("cargo", "build", "--locked", "-p", "wasmer-sdk-uniffi", "--no-default-features",
        "--features", "sys,bindgen-cli", "--lib", "--bin", "uniffi-bindgen", env=env)
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"], cwd=ROOT))
    target_dir = Path(metadata["target_directory"])
    host_lib = target_dir / "debug" / ("libwasmer_sdk_uniffi.dylib" if sys.platform == "darwin" else "libwasmer_sdk_uniffi.so")
    run(target_dir / "debug/uniffi-bindgen", "generate", "--library", host_lib,
        "--language", "kotlin", "--out-dir", KOTLIN / "sdk/src/main/kotlin", "--no-format")
    # UniFFI emits trailing spaces and blank lines; normalize the checked-in file.
    bindings = KOTLIN / "sdk/src/main/kotlin/io/wasmer/sdk/ffi/wasmer_sdk_uniffi.kt"
    bindings.write_text("\n".join(line.rstrip() for line in bindings.read_text().splitlines()).rstrip() + "\n")
    if not args.android:
        return
    dependencies = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", "aarch64-linux-android"], cwd=ROOT))
    # The vendored Java helper is part of the JNI ABI. Review it when upgrading Rust.
    versions = {p["name"]: p["version"] for p in dependencies["packages"]}
    if (versions["rustls-platform-verifier"], versions["rustls-platform-verifier-android"]) != ("0.7.0", "0.1.1"):
        raise SystemExit("Review the vendored Android TLS helper for the updated Rust verifier")
    for abi in abis:
        target, _ = TARGETS[abi]
        build_env, toolchain = android_env(abi)
        run("rustup", "target", "add", target)
        run("cargo", "build", "--locked", "-p", "wasmer-sdk-uniffi", "--lib", "--target", target,
            "--no-default-features", "--features", "sys" if args.no_node else "napi-v8",
            *(["--release"] if args.release else []), env=build_env)
        output = KOTLIN / "android/build/generated/jniLibs" / abi
        output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target_dir / target / ("release" if args.release else "debug") / "libwasmer_sdk_uniffi.so", output)
        shutil.copy2(toolchain / f"sysroot/usr/lib/{target}/libc++_shared.so", output)
        if args.shell:
            prefix = ghostty(abi, toolchain)
            bridge = KOTLIN / "shell/build/generated/jniLibs" / abi
            bridge.mkdir(parents=True, exist_ok=True)
            run(toolchain / f"bin/{target}28-clang", "-shared", "-fPIC", "-O2", "-Wl,-z,max-page-size=16384",
                "-I", prefix / "include", "-I", ROOT / "swift/Examples/WasmerShell",
                KOTLIN / "shell/src/main/cpp/ghostty_jni.c", ROOT / "swift/Examples/WasmerShell/GhosttyBridge.c",
                prefix / "lib/libghostty-vt.a", "-lm", "-Wl,--no-undefined", "-o", bridge / "libwasmer_terminal.so")
            assets = KOTLIN / "shell/build/generated/assets"
            assets.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / ".build/ghostty/LICENSE", assets / "Ghostty-LICENSE.txt")


if __name__ == "__main__":
    main()
