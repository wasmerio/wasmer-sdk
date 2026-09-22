import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import go_release as go


class GoReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "go"
        for path in ("internal/ffi", "internal/distribution", "cmd/wasmer-sdk"):
            (self.package / path).mkdir(parents=True)
        for name in (*go.GENERATED, "wasmer.go", "internal/ffi/link.go", "cmd/wasmer-sdk/main.go"):
            (self.package / name).write_text("// fixture\n")
        (self.package / "go.mod").write_text("module go.wasmer.io/sdk\n\ngo 1.26.0\n")
        (self.package / "LICENSE").write_text("license")
        (self.package / "README.md").write_text("readme")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], cwd=self.root, check=True)
        self.sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.bindings_hash = hashlib.sha256(b"".join((self.package / p).read_bytes() for p in go.GENERATED)).hexdigest()

    def native(self, platform):
        native = self.root / platform
        (native / "static").mkdir(parents=True)
        (native / "dynamic").mkdir()
        osname, arch = platform.split("-")
        ext = "dylib" if osname == "darwin" else "so"
        header = bytearray(64)
        if osname == "darwin":
            header[:4] = b"\xcf\xfa\xed\xfe"
            header[4:8] = (0x100000C if arch == "arm64" else 0x1000007).to_bytes(4,"little")
        else:
            header[:6] = b"\x7fELF\x02\x01"
            header[18:20] = (183 if arch == "arm64" else 62).to_bytes(2,"little")
        (native / "dynamic" / ("libwasmer_sdk_uniffi." + ext)).write_bytes(header)
        (native / "static/libwasmer_sdk_uniffi.a").write_bytes(b"!<arch>\nfixture")
        (native / "LICENSE").write_text("license")
        (native / "native.json").write_text(json.dumps({
            "schema": 1, "version": "0.1.0", "goos": osname, "goarch": arch,
            "source_sha": self.sha, "static_link_flags": "-lc", "bindings_sha256": self.bindings_hash,
            "dynamic_library": "libwasmer_sdk_uniffi." + ext,
        }))
        go.pack_native(native,self.assets,"0.1.0")
        return native

    def complete(self):
        for platform in go.PLATFORMS:
            self.native(platform)
        go.pack_module(self.assets,"0.1.0",self.root)

    def test_complete_release_and_reproducible_source_zip(self):
        self.complete()
        self.assertEqual(len(go.validate_assets(self.assets,"0.1.0")),7)
        digest = go.digest(self.assets / "v0.1.0.zip")
        go.pack_module(self.assets,"0.1.0",self.root)
        self.assertEqual(digest,go.digest(self.assets / "v0.1.0.zip"))

    def test_missing_platform_cannot_be_published(self):
        self.native("linux-amd64")
        go.pack_module(self.assets,"0.1.0",self.root,complete=False)
        with self.assertRaisesRegex(ValueError,"asset set"):
            go.validate_assets(self.assets,"0.1.0")

    def test_mod_and_zip_must_match(self):
        self.complete()
        (self.assets / "v0.1.0.mod").write_text("module different.example/sdk\n")
        with self.assertRaisesRegex(ValueError,"differs"):
            go.validate_assets(self.assets,"0.1.0")

    def test_different_interface_is_rejected(self):
        for platform in go.PLATFORMS:
            self.native(platform)
        (self.package / go.GENERATED[0]).write_text("// changed\n")
        with self.assertRaisesRegex(ValueError,"interface"):
            go.pack_module(self.assets,"0.1.0",self.root)

    def test_wrong_architecture_is_rejected(self):
        native = self.native("linux-amd64")
        lib = native / "dynamic/libwasmer_sdk_uniffi.so"
        data = bytearray(lib.read_bytes()); data[18:20] = (183).to_bytes(2,"little"); lib.write_bytes(data)
        with self.assertRaisesRegex(ValueError,"architecture"):
            go.pack_native(native,self.assets,"0.1.0")

    def test_native_changes_break_embedded_hash(self):
        self.complete()
        native = self.root / "linux-amd64"
        (native / "LICENSE").write_text("changed")
        go.pack_native(native,self.assets,"0.1.0")
        with self.assertRaisesRegex(ValueError,"checksum"):
            go.validate_assets(self.assets,"0.1.0")

    def test_generated_sources_cannot_be_tracked(self):
        with self.assertRaisesRegex(ValueError,"Generated artifact tracked"):
            go.check_sources(self.root)


if __name__ == "__main__":
    unittest.main()
