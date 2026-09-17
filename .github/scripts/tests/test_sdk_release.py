import importlib.util
import io
import json
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sdk_release as release
import registry_pending
import github_release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        for folder in ('js', 'python', 'swift/Sources/WasmerSDKCore', 'rust', '.github'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        self.write('js/package.json', {'name': '@wasmer/sdk', 'version': '0.13.0'})
        self.write('js/package-lock.json', {'version': '0.13.0', 'packages': {'': {'version': '0.13.0'}}})
        (self.root / 'python/pyproject.toml').write_text('[project]\nname="wasmer-sdk"\nversion="0.2.1"\n')
        (self.root / 'swift/version.txt').write_text('0.2.1\n')
        (self.root / release.SWIFT_SOURCE).write_text('// old bindings\n')
        (self.root / 'rust/lib.rs').write_text('// native input\n')
        (self.root / 'Package.swift').write_text(release.swift_manifest('0.2.1', 'wasmerio/wasmer-sdk', None))
        self.git('init', '-q')
        self.git('add', '.')
        self.commit()
        self.assets = Path(self.temp.name) / 'assets'
        self.assets.mkdir()

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self):
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')

    def swift_archive(self):
        bundle = self.assets / release.swift_archive('0.2.1')
        info = {'AvailableLibraries': [{
            'LibraryIdentifier': 'macos-arm64_x86_64', 'LibraryPath': 'library.a',
            'HeadersPath': 'Headers', 'SupportedPlatform': 'macos',
            'SupportedArchitectures': ['arm64', 'x86_64'],
        }]}
        prefix = 'WasmerSDKFFI.xcframework/'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.writestr(prefix + 'Info.plist', plistlib.dumps(info))
            archive.writestr(prefix + 'macos-arm64_x86_64/library.a', b'archive')
            archive.writestr(prefix + 'macos-arm64_x86_64/Headers/module.modulemap', 'module WasmerSDKFFI {}')
        (self.assets / 'WasmerSDKCore.swift').write_text('// generated bindings\n')
        return bundle

    def seal_swift(self):
        bundle = self.swift_archive()
        release.seal(self.assets, 'swift', run_id='1234', root=self.root)
        return bundle

    def wheels(self):
        for platform in ('manylinux_2_35_x86_64', 'manylinux_2_35_aarch64', 'macosx_12_0_arm64', 'macosx_12_0_x86_64'):
            name = f'wasmer_sdk-0.2.1-py3-none-{platform}.whl'
            with zipfile.ZipFile(self.assets / name, 'w') as archive:
                archive.writestr('wasmer_sdk-0.2.1.dist-info/METADATA', 'Name: wasmer-sdk\nVersion: 0.2.1\n')
                archive.writestr('wasmer_sdk/libnative.so', 'native')

    def npm(self):
        target = self.assets / 'wasmer-sdk-0.13.0.tgz'
        with tarfile.open(target, 'w:gz') as archive:
            for name, data in {
                'package/package.json': json.dumps({'name': '@wasmer/sdk', 'version': '0.13.0'}).encode(),
                'package/dist/node.js': b'node', 'package/dist/index.js': b'browser',
                'package/pkg/wasmer.wasm': b'wasm',
            }.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return target

    def test_component_versions_remain_independent(self):
        self.assertEqual(release.version('js', self.root), '0.13.0')
        self.assertEqual(release.version('python', self.root), '0.2.1')
        self.assertEqual(release.version('swift', self.root), '0.2.1')
        with self.assertRaisesRegex(ValueError, 'differs'):
            release.version('swift', self.root, 'wasmer-sdk-python-v0.2.1')

    def test_npm_lock_drift_is_rejected(self):
        self.write('js/package-lock.json', {'version': '0.12.0', 'packages': {'': {'version': '0.13.0'}}})
        with self.assertRaisesRegex(ValueError, 'lockfile'):
            release.version('js', self.root)

    def test_swift_preparation_survives_commit_but_rejects_native_changes(self):
        self.seal_swift()
        self.git('add', '.')
        self.commit()
        release.verify(self.assets, 'swift', root=self.root)
        (self.root / 'rust/lib.rs').write_text('// changed native code')
        with self.assertRaisesRegex(ValueError, 'inputs changed'):
            release.verify(self.assets, 'swift', root=self.root)

    def test_independent_js_changes_do_not_invalidate_swift(self):
        self.seal_swift()
        self.write('js/package.json', {'name': '@wasmer/sdk', 'version': '0.14.0'})
        release.verify(self.assets, 'swift', root=self.root)

    def test_modified_swift_checksum_or_binding_is_rejected(self):
        self.seal_swift()
        manifest = self.root / 'Package.swift'
        manifest.write_text(manifest.read_text().replace('releases/download/', 'releases/wrong/'))
        with self.assertRaisesRegex(ValueError, 'URL/checksum'):
            release.verify(self.assets, 'swift', root=self.root)
        (self.root / release.SWIFT_SOURCE).write_text('// tampered')
        with self.assertRaisesRegex(ValueError, 'bindings changed'):
            release.verify(self.assets, 'swift', root=self.root)

    def test_modified_release_bytes_are_rejected(self):
        bundle = self.seal_swift()
        with zipfile.ZipFile(bundle, 'a') as archive:
            archive.writestr('changed', b'tampering')
        with self.assertRaisesRegex(ValueError, 'checksums differ'):
            release.verify(self.assets, 'swift', root=self.root)

    def test_full_python_matrix_required(self):
        self.wheels()
        self.assertEqual(len(release.validate_assets(self.assets, 'python', '0.2.1')), 4)
        next(self.assets.glob('*aarch64.whl')).unlink()
        with self.assertRaisesRegex(ValueError, 'Wrong artifact set'):
            release.validate_assets(self.assets, 'python', '0.2.1')

    def test_python_retry_only_publishes_missing_identical_wheels(self):
        self.wheels()
        release.seal(self.assets, 'python', root=self.root)
        first = next(self.assets.glob('*.whl'))
        remote = {'urls': [{'filename': first.name, 'digests': {'sha256': release.digest(first)}}]}
        metadata = release.verify(self.assets, 'python', root=self.root)
        with patch.object(registry_pending, 'verify', return_value=metadata), patch.object(registry_pending, 'fetch_json', return_value=remote):
            self.assertEqual(len(registry_pending.pending('python', self.assets)), 3)
            remote['urls'][0]['digests']['sha256'] = 'bad'
            with self.assertRaisesRegex(ValueError, 'different bytes'):
                registry_pending.pending('python', self.assets)

    def test_npm_tarball_contains_both_entrypoints_and_wasm(self):
        self.npm()
        release.seal(self.assets, 'js', root=self.root)
        release.verify(self.assets, 'js', root=self.root)
        with self.assertRaisesRegex(ValueError, 'differs'):
            release.validate_assets(self.assets, 'js', '0.14.0')

    def test_js_retry_checks_registry_integrity(self):
        tarball = self.npm()
        release.seal(self.assets, 'js', root=self.root)
        metadata = release.verify(self.assets, 'js', root=self.root)
        import base64
        import hashlib
        remote = {'dist': {'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()}}
        with patch.object(registry_pending, 'verify', return_value=metadata), patch.object(registry_pending, 'fetch_json', return_value=remote):
            self.assertEqual(registry_pending.pending('js', self.assets), [])
            remote['dist']['integrity'] = 'sha512-bad'
            with self.assertRaisesRegex(ValueError, 'different bytes'):
                registry_pending.pending('js', self.assets)

    def test_github_assets_are_uploaded_before_draft_is_published(self):
        self.npm()
        release.seal(self.assets, 'js', root=self.root)
        metadata = release.verify(self.assets, 'js', root=self.root)
        calls = []

        def gh(*args):
            calls.append(args)
            if args[0] == 'api':
                return metadata['source_sha']
            if args[:2] == ('release', 'view'):
                return json.dumps({'assets': [], 'isDraft': True})
            return ''

        with patch.object(github_release, 'verify', return_value=metadata), \
             patch.object(github_release, 'gh', side_effect=gh), \
             patch.object(github_release.subprocess, 'check_output', return_value=metadata['source_sha']), \
             patch.dict('os.environ', {'GITHUB_REPOSITORY': 'wasmerio/wasmer-sdk'}):
            github_release.upload('js', self.assets)
        self.assertEqual(len([call for call in calls if call[:2] == ('release', 'upload')]), 3)
        self.assertEqual(calls[-1][:2], ('release', 'edit'))
        self.assertIn('--draft=false', calls[-1])

    def test_github_retry_rejects_different_existing_asset_without_clobbering(self):
        self.npm()
        release.seal(self.assets, 'js', root=self.root)
        metadata = release.verify(self.assets, 'js', root=self.root)
        calls = []
        first = sorted(self.assets.iterdir())[0]

        def gh(*args):
            calls.append(args)
            if args[0] == 'api':
                return metadata['source_sha']
            if args[:2] == ('release', 'view'):
                return json.dumps({'assets': [{'name': first.name}], 'isDraft': True})
            if args[:2] == ('release', 'download'):
                (Path(args[-1]) / first.name).write_text('different bytes')
            return ''

        with patch.object(github_release, 'verify', return_value=metadata), \
             patch.object(github_release, 'gh', side_effect=gh), \
             patch.object(github_release.subprocess, 'check_output', return_value=metadata['source_sha']), \
             patch.dict('os.environ', {'GITHUB_REPOSITORY': 'wasmerio/wasmer-sdk'}):
            with self.assertRaisesRegex(ValueError, 'Existing asset differs'):
                github_release.upload('js', self.assets)
        self.assertFalse(any(call[:2] in (('release', 'upload'), ('release', 'edit')) for call in calls))


class ConfigurationTests(unittest.TestCase):
    def test_publication_configs_match_pr_configs(self):
        root = Path(__file__).resolve().parents[3]
        config = release.read_json(root / 'release-please-config.json')
        self.assertTrue(config['separate-pull-requests'])
        self.assertNotIn('plugins', config)
        for component in ('js', 'python', 'swift'):
            single = release.read_json(root / '.github/release-please' / f'{component}.json')
            self.assertEqual(single['packages'], {component: config['packages'][component]})
            self.assertTrue(single['draft'])
            self.assertTrue(single['force-tag-creation'])

    def test_python_auto_backend_matches_supported_release_targets(self):
        root = Path(__file__).resolve().parents[3]
        spec = importlib.util.spec_from_file_location('python_build', root / 'python/scripts/build.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        for system, machine, expected in (
            ('Darwin', 'arm64', 'napi-v8'), ('Darwin', 'x86_64', 'sys'),
            ('Linux', 'x86_64', 'napi-v8'), ('Linux', 'aarch64', 'sys'),
        ):
            with self.subTest(system=system, machine=machine), \
                 patch.object(builder.platform, 'system', return_value=system), \
                 patch.object(builder.platform, 'machine', return_value=machine):
                self.assertEqual(builder.default_backend(), expected)


if __name__ == '__main__':
    unittest.main()
