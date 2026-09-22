#!/usr/bin/env python3
"""Build native Go artifacts and generate bindings without adding them to Git."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parent
TARGETS = {
    "aarch64-apple-darwin": ("darwin", "arm64", "napi-v8"),
    "x86_64-apple-darwin": ("darwin", "amd64", "sys"),
    "aarch64-unknown-linux-gnu": ("linux", "arm64", "sys"),
    "x86_64-unknown-linux-gnu": ("linux", "amd64", "napi-v8"),
}


def run(args: list[str], **kwargs) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def output(args: list[str]) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--backend", choices=("auto", "sys", "napi-v8"), default="auto")
    args = parser.parse_args()
    if not shutil.which("go"):
        parser.error("Go 1.26 or newer is required on PATH")
    if os.environ.get("CARGO_BUILD_TARGET"):
        parser.error("native builds require CARGO_BUILD_TARGET to be unset")
    target = next(line[6:] for line in output(["rustc", "-vV"]).splitlines() if line.startswith("host: "))
    if target not in TARGETS:
        parser.error(f"unsupported native target: {target}")
    goos, goarch, default_backend = TARGETS[target]
    build_env = dict(os.environ)
    if goos == "darwin":
        # Match Swift's baseline, including native C/assembly dependencies.
        build_env["MACOSX_DEPLOYMENT_TARGET"] = "12.0"
        build_env["CFLAGS"] = (build_env.get("CFLAGS", "") + " -mmacosx-version-min=12.0").strip()
    backend = default_backend if args.backend == "auto" else args.backend
    pin = json.loads((PACKAGE / "generator.json").read_text())
    install = PACKAGE / ".build/bindgen"
    generator = install / "bin/uniffi-bindgen-go"
    receipt = install / "revision"
    if not generator.exists() or not receipt.exists() or receipt.read_text().strip() != pin["revision"]:
        run(["cargo", "install", "uniffi-bindgen-go", "--git", pin["repository"], "--rev", pin["revision"],
             "--locked", "--root", str(install), "--force", "--jobs", "2"])
        receipt.write_text(pin["revision"] + "\n")
    profile = "release" if args.release else "debug"
    # Avoid Rust's Mach-O stripping bug on macOS 27 (rust-lang/rust#157750).
    # Only the facade's final link changes; other SDK consumers keep their settings.
    command = ["cargo", "rustc", "--locked", "-p", "wasmer-sdk-uniffi", "--no-default-features",
               "--features", backend, "--lib", *(["--release"] if args.release else []),
               "--", "--print", "native-static-libs", *(["-C", "strip=none"] if goos == "darwin" else [])]
    print("+", " ".join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=build_env, text=True, capture_output=True)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        result.check_returncode()
    flags = next((line.split("native-static-libs:", 1)[1].strip() for line in result.stderr.splitlines()
                  if "native-static-libs:" in line), None)
    if flags is None:
        raise RuntimeError("Rust did not report native-static-libs")
    cargo = json.loads(output(["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"]))
    native_dir = Path(cargo["target_directory"]) / profile
    dynamic_name = "libwasmer_sdk_uniffi." + ("dylib" if goos == "darwin" else "so")
    run([str(generator), "--library", str(native_dir / dynamic_name), "--crate", "wasmer_sdk_uniffi",
         "--config", str(PACKAGE / "uniffi.toml"), "--out-dir", str(PACKAGE / "internal")])
    destination = PACKAGE / "Artifacts" / f"{goos}-{goarch}"
    for mode, name in (("static", "libwasmer_sdk_uniffi.a"), ("dynamic", dynamic_name)):
        (destination / mode).mkdir(parents=True, exist_ok=True)
        shutil.copy2(native_dir / name, destination / mode / name)
    if goos == "darwin":
        run(["xcrun", "install_name_tool", "-id", "@rpath/" + dynamic_name, str(destination / "dynamic" / dynamic_name)])
        run(["codesign", "--force", "--sign", "-", str(destination / "dynamic" / dynamic_name)])
    else:
        run(["patchelf", "--set-soname", dynamic_name, "--set-rpath", "$ORIGIN", str(destination / "dynamic" / dynamic_name)])
    shared_library = destination / "dynamic" / dynamic_name
    if goos == "darwin":
        dependencies = [line.strip().split(" (", 1)[0] for line in output(["otool", "-L", str(shared_library)]).splitlines()[1:]]
        unexpected = [name for name in dependencies if not name.startswith(("/usr/lib/", "/System/Library/"))
                      and name != "@rpath/" + dynamic_name]
    else:
        dependencies = output(["patchelf", "--print-needed", str(shared_library)]).splitlines()
        system = {"libc.so.6", "libm.so.6", "libgcc_s.so.1", "libstdc++.so.6", "libpthread.so.0",
                  "libdl.so.2", "librt.so.1", "libutil.so.1", "libresolv.so.2",
                  "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1"}
        unexpected = sorted(set(dependencies) - system)
    if unexpected:
        raise RuntimeError(f"Native archive has unbundled third-party dependencies: {unexpected}")
    metadata = {
        "schema": 1, "version": (PACKAGE / "version.txt").read_text().strip(),
        "source_sha": output(["git", "rev-parse", "HEAD"]),
        "goos": goos, "goarch": goarch, "target": target, "backend": backend,
        "uniffi": pin["uniffi"], "generator_revision": pin["revision"],
        "static_link_flags": flags, "dynamic_library": dynamic_name,
        "build_os": platform.platform(),
        "dynamic_dependencies": dependencies,
        "minimum_os": "macOS 12" if goos == "darwin" else "glibc 2.35 (Ubuntu 22.04)",
        "bindings_sha256": hashlib.sha256(b"".join((PACKAGE / "internal/ffi" / name).read_bytes()
            for name in ("wasmer_sdk_uniffi.go", "wasmer_sdk_uniffi.h"))).hexdigest(),
    }
    (destination / "native.json").write_text(json.dumps(metadata, indent=2) + "\n")
    shutil.copy2(PACKAGE / "LICENSE", destination / "LICENSE")
    fixtures = PACKAGE / "testdata"
    fixtures.mkdir(exist_ok=True)
    for source in (ROOT / "swift/Tests/WasmerSDKTests/Fixtures").glob("*.wasm"):
        shutil.copy2(source, fixtures / source.name)
    shutil.copy2(ROOT / "fixtures/edgejs/server.js", fixtures / "edgejs-server.js")
    for name in ("python/hello.py", "edgejs/server.js", "postgres/query.sql"):
        path = PACKAGE / "examples/internal/guest/fixtures" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "fixtures" / name, path)
    print(f"Built {destination}")


if __name__ == "__main__":
    main()
