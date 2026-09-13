"""Run with python3 tests/python-extensions.py (no WASIX runtime required)."""
import importlib.machinery as machinery
import pathlib
import runpy
import sys
import tempfile
import unittest

HOOK = pathlib.Path(__file__).resolve().parents[1] / 'python/sitecustomize.py'
NATIVE = '.cpython-313-wasm32-wasi.so'
WHEEL = '.cpython-313-wasm32-wasi-threads.so'


class ExtensionDiscoveryTest(unittest.TestCase):
    def test_generic_discovery_and_abi_filtering(self):
        suffixes = machinery.EXTENSION_SUFFIXES[:]
        hooks = sys.path_hooks[:]
        cache = sys.path_importer_cache.copy()
        try:
            machinery.EXTENSION_SUFFIXES[:] = [NATIVE, '.abi3.so', '.so']
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                (root / ('arbitrary' + WHEEL)).touch()
                (root / ('wrong_abi.cpython-312-wasm32-wasi-threads.so')).touch()
                (root / 'ordinary.py').write_text('value = 42\n')
                package = root / 'nested'
                package.mkdir()
                (package / ('__init__' + WHEEL)).touch()
                # A cached finder created before startup must be refreshed.
                machinery.PathFinder.find_spec('arbitrary', [directory])
                runpy.run_path(str(HOOK))
                spec = machinery.PathFinder.find_spec('arbitrary', [directory])
                self.assertIsInstance(spec.loader, machinery.ExtensionFileLoader)
                self.assertTrue(spec.origin.endswith(WHEEL))
                self.assertIsNone(machinery.PathFinder.find_spec('wrong_abi', [directory]))
                self.assertIsInstance(machinery.PathFinder.find_spec('ordinary', [directory]).loader, machinery.SourceFileLoader)
                self.assertIsNotNone(machinery.PathFinder.find_spec('nested', [directory]).submodule_search_locations)
                (root / ('arbitrary' + NATIVE)).touch()
                machinery.PathFinder.invalidate_caches()
                self.assertTrue(machinery.PathFinder.find_spec('arbitrary', [directory]).origin.endswith(NATIVE))
                runpy.run_path(str(HOOK))
                self.assertEqual(machinery.EXTENSION_SUFFIXES.count(WHEEL), 1)
        finally:
            machinery.EXTENSION_SUFFIXES[:] = suffixes
            sys.path_hooks[:] = hooks
            sys.path_importer_cache.clear()
            sys.path_importer_cache.update(cache)


if __name__ == '__main__':
    unittest.main()
