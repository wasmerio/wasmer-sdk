#!/usr/bin/env python3
"""Assemble and validate release-only Go sources and native archives."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
MODULE = "go.wasmer.io/sdk"
PLATFORMS = {"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"}
GENERATED = ("internal/ffi/wasmer_sdk_uniffi.go", "internal/ffi/wasmer_sdk_uniffi.h")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_name(version: str, platform: str) -> str:
    return f"wasmer-sdk-go-{version}-{platform}.tar.gz"


def read_native(archive: Path, version: str, platform: str) -> dict:
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        require(len(names) == len(set(names)), "Duplicate native archive member")
        for m in members:
            require(m.isfile() and not m.name.startswith("/") and ".." not in PurePosixPath(m.name).parts
                    and "\\" not in m.name, "Unsafe native archive member")
        require("native.json" in names, "Native archive has no metadata")
        metadata = json.load(tar.extractfile("native.json"))
        require(metadata["schema"] == 1 and metadata["version"] == version
                and metadata["goos"] + "-" + metadata["goarch"] == platform,
                "Native archive identity differs from release")
        ext = "dylib" if platform.startswith("darwin") else "so"
        library = "libwasmer_sdk_uniffi." + ext
        require(metadata["dynamic_library"] == library, "Unexpected shared library name")
        require(metadata["static_link_flags"], "Missing static system link requirements")
        require(re.fullmatch(r"[a-f0-9]{40}", metadata["source_sha"]) is not None,
                "Missing native build source identity")
        for name in ("LICENSE", "static/libwasmer_sdk_uniffi.a", "dynamic/" + library):
            require(name in names and tar.getmember(name).size > 0, f"Native archive missing {name}")
        require(tar.extractfile("static/libwasmer_sdk_uniffi.a").read(8) == b"!<arch>\n", "Invalid static archive")
        header = tar.extractfile("dynamic/" + library).read(64)
        if platform.startswith("linux"):
            require(header[:6] == b"\x7fELF\x02\x01", "Shared library must be little-endian ELF64")
            require(int.from_bytes(header[18:20], "little") == (183 if platform.endswith("arm64") else 62),
                    "Wrong shared library architecture")
        else:
            require(header[:4] == b"\xcf\xfa\xed\xfe", "Shared library must be Mach-O 64")
            require(int.from_bytes(header[4:8], "little") == (0x100000C if platform.endswith("arm64") else 0x1000007),
                    "Wrong shared library architecture")
        return metadata


def pack_native(native: Path, output: Path, version: str) -> Path:
    metadata = json.loads((native / "native.json").read_text())
    platform = metadata["goos"] + "-" + metadata["goarch"]
    require(platform in PLATFORMS and metadata["version"] == version, "Unexpected native target/version")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / archive_name(version, platform)
    with archive.open("wb") as stream, gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            for path in sorted(native.rglob("*")):
                if not path.is_file():
                    continue
                require(not path.is_symlink(), f"Unexpected native symlink: {path}")
                info = tar.gettarinfo(str(path), arcname=path.relative_to(native).as_posix())
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with path.open("rb") as source:
                    tar.addfile(info, source)
    read_native(archive, version, platform)
    return archive


def pack_module(directory: Path, version: str, root: Path = ROOT, complete: bool = True) -> None:
    package = root / "go"
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    time = subprocess.check_output(["git", "show", "-s", "--format=%cI", "HEAD"], cwd=root, text=True).strip()
    from datetime import datetime, timezone
    time = datetime.fromisoformat(time).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    platforms = {}
    interface_hashes = set()
    for platform in sorted(PLATFORMS):
        archive = directory / archive_name(version, platform)
        if not archive.exists() and not complete:
            continue
        metadata = read_native(archive, version, platform)
        require(metadata["source_sha"] == sha, "Native archive was built from a different commit")
        interface_hashes.add(metadata["bindings_sha256"])
        platforms[platform] = {
            "url": f"https://github.com/wasmerio/wasmer-sdk/releases/download/wasmer-sdk-go-v{version}/{archive.name}",
            "sha256": digest(archive), "size": archive.stat().st_size,
        }
    source_hash = hashlib.sha256(b"".join((package / name).read_bytes() for name in GENERATED)).hexdigest()
    require(interface_hashes == {source_hash}, "Native targets disagree with the packaged Go interface")
    manifest = {"schema": 1, "module": MODULE, "version": version, "source_sha": sha, "platforms": platforms}
    # Whitelist module inputs: no native libraries, build outputs, proxy or tooling.
    paths = [*package.glob("*.go"), package / "go.mod", package / "LICENSE", package / "README.md"]
    for subdirectory in ("internal", "cmd", "examples", "testdata"):
        for path in (package / subdirectory).rglob("*"):
            if path.is_file() and path.suffix in {".go", ".h", ".c", ".json", ".wasm"}:
                if path.relative_to(package).as_posix() != "internal/distribution/native.json":
                    paths.append(path)
    contents = {path.relative_to(package).as_posix(): path.read_bytes() for path in paths}
    for path in (root / "swift/Tests/WasmerSDKTests/Fixtures").glob("*.wasm"):
        contents["testdata/" + path.name] = path.read_bytes()
    edgejs = root / "fixtures/edgejs/server.js"
    if edgejs.exists():
        contents["testdata/edgejs-server.js"] = edgejs.read_bytes()
    contents["internal/distribution/native.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    prefix = f"{MODULE}@v{version}/"
    with zipfile.ZipFile(directory / f"v{version}.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(contents.items()):
            info = zipfile.ZipInfo(prefix + name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    (directory / f"v{version}.mod").write_bytes(contents["go.mod"])
    (directory / f"v{version}.info").write_text(json.dumps({"Version": "v" + version, "Time": time}) + "\n")
    validate_assets(directory, version, complete=complete)


def validate_assets(directory: Path, version: str, complete: bool = True) -> dict[str, str]:
    platforms = PLATFORMS if complete else {p for p in PLATFORMS if (directory / archive_name(version,p)).exists()}
    expected = {f"v{version}.{ext}" for ext in ("info", "mod", "zip")} | {archive_name(version,p) for p in platforms}
    actual = {p.name for p in directory.iterdir()} - {"release-metadata.json", "SHA256SUMS"}
    require(actual == expected and platforms, "Incomplete or unexpected Go release asset set")
    info = json.loads((directory / f"v{version}.info").read_text())
    require(info["Version"] == "v" + version and info.get("Time"), "Incorrect Go module version metadata")
    prefix = f"{MODULE}@v{version}/"
    archive_path = directory / f"v{version}.zip"
    require(archive_path.stat().st_size <= 500 * 1024**2, "Go module ZIP is too large")
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate Go module ZIP entry")
        require(sum(i.file_size for i in archive.infolist()) <= 500 * 1024**2, "Expanded Go module is too large")
        for name in names:
            require(name.startswith(prefix) and ".." not in PurePosixPath(name).parts and "\\" not in name,
                    "Invalid Go module ZIP path")
            require(not name.endswith((".a", ".so", ".dylib")), "Native libraries must remain outside the module ZIP")
        for name in (*GENERATED, "wasmer.go", "internal/ffi/link.go", "cmd/wasmer-sdk/main.go", "LICENSE"):
            require(prefix + name in names, f"Missing Go module source {name}")
        module = archive.read(prefix + "go.mod")
        require(module == (directory / f"v{version}.mod").read_bytes(), "Go .mod differs from source ZIP")
        require(re.search(rb"^module go\.wasmer\.io/sdk\s*$", module, re.M) is not None, "Incorrect Go module identity")
        manifest = json.loads(archive.read(prefix + "internal/distribution/native.json"))
        require(manifest["schema"] == 1 and manifest["module"] == MODULE and manifest["version"] == version
                and set(manifest["platforms"]) == platforms, "Incorrect embedded native manifest")
        source_hash = hashlib.sha256(b"".join(archive.read(prefix + name) for name in GENERATED)).hexdigest()
        for platform in platforms:
            native_archive = directory / archive_name(version,platform)
            metadata = read_native(native_archive,version,platform)
            require(metadata["source_sha"] == manifest["source_sha"] and metadata["bindings_sha256"] == source_hash,
                    "Native library source/interface differs from the Go module")
            entry = manifest["platforms"][platform]
            require(entry["sha256"] == digest(native_archive) and entry["size"] == native_archive.stat().st_size,
                    "Embedded native archive checksum/size differs")
            require(entry["url"] == f"https://github.com/wasmerio/wasmer-sdk/releases/download/wasmer-sdk-go-v{version}/{native_archive.name}",
                    "Unexpected native archive URL")
    return {name: digest(directory / name) for name in sorted(expected)}


def check_sources(root: Path = ROOT) -> None:
    tracked = subprocess.check_output(["git", "ls-files", "go", "-z"], cwd=root).decode().split("\0")
    for name in tracked:
        require(not name.endswith((".a", ".so", ".dylib")) and name not in {"go/" + n for n in GENERATED}
                and not name.startswith(("go/Artifacts/", "go/.build/", "go/testdata/")), f"Generated artifact tracked in Git: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("native", "module", "check"))
    parser.add_argument("--native", type=Path)
    parser.add_argument("--assets", type=Path, default=ROOT / "release-build")
    parser.add_argument("--local", action="store_true", help="permit one platform for local consumer tests only")
    args = parser.parse_args()
    version = (ROOT / "go/version.txt").read_text().strip()
    check_sources()
    if args.command == "native":
        require(args.native is not None, "--native is required")
        print(pack_native(args.native, args.assets, version))
    elif args.command == "module":
        pack_module(args.assets, version, complete=not args.local)


if __name__ == "__main__":
    main()
