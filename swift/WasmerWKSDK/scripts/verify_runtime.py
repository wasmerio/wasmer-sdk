#!/usr/bin/env python3
"""Verify the archived runtime through a clean SwiftPM consumer on macOS."""
import importlib.util
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("sdk_release", REPO / ".github/scripts/sdk_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def verify():
    artifact = REPO / "swift/Artifacts/WasmerWKRuntime.zip"
    release.archive_framework(REPO / "swift/Artifacts/WasmerWKRuntime.xcframework", artifact)
    release.validate_swift_runtime(artifact)
    with tempfile.TemporaryDirectory(prefix="wasmer-runtime-consumer-") as temporary:
        root = Path(temporary)
        # ditto preserves the macOS framework's versioned bundle symlinks.
        subprocess.run(["ditto", "-xk", artifact, root], check=True)
        (root / "Package.swift").write_text('''// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "RuntimeConsumer", platforms: [.macOS(.v12)], targets: [
    .binaryTarget(name: "WasmerWKRuntime", path: "WasmerWKRuntime.xcframework"),
    .executableTarget(name: "Consumer", dependencies: ["WasmerWKRuntime"], linkerSettings: [
        .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/Frameworks"]),
    ]),
])
''')
        source = root / "Sources/Consumer"
        source.mkdir(parents=True)
        (source / "main.swift").write_text('''import Foundation
import CryptoKit
import WasmerWKRuntime
guard let web = WasmerWKRuntimeWebURL() else { fatalError("Missing framework resources") }
struct Manifest: Decodable { let files: [String: String] }
let manifest = try JSONDecoder().decode(Manifest.self,
    from: Data(contentsOf: web.appendingPathComponent("sdk/manifest.json")))
for (name, expected) in manifest.files {
    let bytes = try Data(contentsOf: web.appendingPathComponent("sdk/" + name))
    precondition(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == expected)
}
let wasm = try Data(contentsOf: web.appendingPathComponent("sdk/pkg/wasmer_sdk_js_bg.wasm"))
precondition(wasm.prefix(8) == Data([0, 97, 115, 109, 1, 0, 0, 0]))
precondition(FileManager.default.fileExists(atPath: web.appendingPathComponent("index.html").path))
print("Verified SwiftPM runtime archive: \\(manifest.files.count) SDK files, \\(wasm.count) Wasm bytes")
''')
        subprocess.run(["swift", "build", "--package-path", root, "--product", "Consumer"], check=True)
        products = Path(subprocess.check_output(
            ["swift", "build", "--package-path", root, "--show-bin-path"], text=True).strip())
        # A CLI executable has no app embedding phase. Embed the framework as
        # Xcode does for application targets, then run without any DYLD overrides.
        framework = next((root / "WasmerWKRuntime.xcframework").glob("macos-*/*.framework"))
        embedded = products / "Frameworks" / framework.name
        shutil.copytree(framework, embedded, symlinks=True)
        subprocess.run(["codesign", "--force", "--sign", "-", embedded], check=True)
        subprocess.run([products / "Consumer"], check=True)


if __name__ == "__main__":
    verify()
