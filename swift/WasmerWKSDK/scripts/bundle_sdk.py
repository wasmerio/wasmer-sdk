#!/usr/bin/env python3
"""Stage generated browser assets for local builds and CI release packaging."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
DESTINATION = ROOT / "Sources/WasmerWKSDK/Web/sdk"
MANIFEST = DESTINATION / "manifest.json"
INPUTS = ("Cargo.toml", "Cargo.lock", ".cargo", "rust/Cargo.toml", "rust/src",
          "js/bindgen", "js/src", "js/package.json", "js/package-lock.json",
          "js/tsconfig.json", "js/scripts/build-wasm.mjs")
DIST = ("node-compat.js", "browser-worker.js", "capi-worker-bridge.js", "host-filesystem.js", "node-network-rpc.js")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_digest():
    names = subprocess.check_output(["git", "ls-files", "-z", "--", *INPUTS], cwd=REPO).decode().split("\0")
    digest = hashlib.sha256()
    for name in sorted(filter(None, names)):
        digest.update((name + "\0" + sha256(REPO / name) + "\0").encode())
    return digest.hexdigest()


def check():
    if not MANIFEST.is_file():
        raise SystemExit("SDK assets are not built. Run python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm.")
    manifest = json.loads(MANIFEST.read_text())
    if manifest["source_sha256"] != source_digest():
        raise SystemExit("Bundled SDK sources changed. Run prototype.py prepare --rebuild-wasm.")
    actual = {str(p.relative_to(DESTINATION)): sha256(p) for p in DESTINATION.rglob("*")
              if p.is_file() and p != MANIFEST}
    if actual != manifest["files"]:
        raise SystemExit("Bundled SDK resources differ from their manifest. Run prototype.py prepare --rebuild-wasm.")
    print(f"Verified {len(actual)} bundled SDK files", flush=True)


def bundle():
    # Follow only the generated glue's local module imports. wasm-bindgen leaves
    # stale snippet directories on rebuild; those must not enter the package.
    pkg = REPO / "js/pkg"
    pending = [pkg / "wasmer_sdk_js.js"]
    files = {pkg / "wasmer_sdk_js_bg.wasm"}
    while pending:
        path = pending.pop()
        if path in files:
            continue
        files.add(path)
        for relative in re.findall(r'''(?m)^import\b[^\n]*?["'](\.[^"']+)["']''', path.read_text()):
            dependency = (path.parent / relative).resolve()
            dependency.relative_to(pkg)  # No imports outside the bundled pkg.
            pending.append(dependency)
        for license in path.parent.glob("*.LICENSE"):
            files.add(license)
    sources = [(REPO / "js/dist" / name, Path("dist") / name) for name in DIST]
    sources += [(path, Path("pkg") / path.relative_to(pkg)) for path in sorted(files)]
    sources += [(REPO / "LICENSE", Path("LICENSE"))]
    # Read everything before replacing the existing working bundle.
    contents = [(relative, path.read_bytes()) for path, relative in sources]
    shutil.rmtree(DESTINATION, ignore_errors=True)
    for relative, data in contents:
        target = DESTINATION / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    manifest = {
        "sdk_version": json.loads((REPO / "js/package.json").read_text())["version"],
        "source_sha256": source_digest(),
        "rebuild": "python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm",
        "files": {str(relative): sha256(DESTINATION / relative) for relative, _ in contents},
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    check()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    check() if args.check else bundle()
