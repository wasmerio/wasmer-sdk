import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("go_bindings", ROOT / "go/scripts/bindings.py")
bindings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bindings)


class CommittedBindingsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in (*bindings.INPUTS, *bindings.GENERATED, "rust/uniffi/src/lib.rs"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
        bindings.record(self.root)

    def test_unchanged_bindings_need_no_generator(self):
        bindings.check(self.root)

    def test_changed_inputs_or_generated_files_require_regeneration(self):
        for name in (*bindings.INPUTS, *bindings.GENERATED, "rust/uniffi/src/lib.rs"):
            with self.subTest(name=name):
                path = self.root / name
                path.write_text("changed\n")
                with self.assertRaisesRegex(ValueError, "--generate-bindings"):
                    bindings.check(self.root)
                path.write_text("fixture\n")

    def test_new_rust_source_requires_regeneration(self):
        (self.root / "rust/uniffi/src/new_api.rs").write_text("new API\n")
        with self.assertRaisesRegex(ValueError, "new_api.rs"):
            bindings.check(self.root)

    def test_missing_generated_file_requires_regeneration(self):
        (self.root / bindings.GENERATED[0]).unlink()
        with self.assertRaisesRegex(ValueError, "--generate-bindings"):
            bindings.check(self.root)

    def test_invalid_receipt_requires_regeneration(self):
        (self.root / bindings.RECEIPT).write_text("[]")
        with self.assertRaisesRegex(ValueError, "--generate-bindings"):
            bindings.check(self.root)
