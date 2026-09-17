from pathlib import Path
import tempfile
import unittest

from wasmer_sdk import PackageCommandDefinition, PackageDefinition, Wasmer, WasmerError


FIXTURE = Path(__file__).resolve().parents[2] / "rust/tests/fixtures/package-files.wasm"


def definition(data=None):
    return PackageDefinition(
        modules={"app": FIXTURE.read_bytes() if data is None else data},
        commands={"hello": PackageCommandDefinition(module="app")},
        files={"/data/input.txt": "original"},
    )


class PackageDefinitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cache = tempfile.TemporaryDirectory()
        self.client = Wasmer(cache_root=self.cache.name)
        self.sandboxes = []

    async def asyncTearDown(self):
        for sandbox in self.sandboxes:
            await sandbox.close()
        await self.client.close()
        self.cache.cleanup()

    async def test_creation_installation_and_file_isolation(self):
        data = bytearray(FIXTURE.read_bytes())
        pkg = await self.client.packages.create(definition(memoryview(data)))
        data[:] = bytes(len(data))
        self.assertEqual(pkg.commands, ("hello",))
        self.assertEqual(pkg.entrypoint, "hello")
        a = await self.client.sandboxes.create(packages=[pkg])
        self.sandboxes.append(a)
        b = await self.client.sandboxes.create()
        self.sandboxes.append(b)
        await b.install_package(pkg)
        for sandbox in (a, b, a):
            self.assertEqual((await sandbox.command(pkg).run()).text(), "original")
        self.assertEqual((await b.command(pkg.command("hello")).run()).text(), "original")

    async def test_identity_and_invalid_definitions(self):
        first = await self.client.packages.create(definition())
        same = await self.client.packages.create(definition())
        self.assertEqual(first.id, same.id)
        changed = definition()
        changed.files["/data/input.txt"] = "different"
        self.assertNotEqual(first.id, (await self.client.packages.create(changed)).id)
        invalid = definition()
        invalid.commands["hello"] = PackageCommandDefinition("missing")
        for value, code in ((invalid, "INVALID_ARGUMENT"), (definition(b"bad"), "PACKAGE_LOAD_FAILED")):
            with self.assertRaises(WasmerError) as raised:
                await self.client.packages.create(value)
            self.assertEqual(raised.exception.code, code)
        await self.client.close()
        with self.assertRaises(WasmerError) as raised:
            await self.client.packages.create(definition())
        self.assertEqual(raised.exception.code, "CLIENT_CLOSED")

    async def test_raw_wasm_load_has_an_automatic_main_entrypoint(self):
        wasm = (FIXTURE.parents[3] / "swift/Tests/WasmerSDKTests/Fixtures/hello.wasm").read_bytes()
        pkg = await self.client.packages.load(wasm)
        self.assertEqual(pkg.commands, ("main",))
        self.assertEqual(pkg.entrypoint, "main")
        explicit = await self.client.packages.create(PackageDefinition(
            modules={"main": wasm},
            commands={"main": PackageCommandDefinition("main")},
        ))
        self.assertEqual(pkg.id, explicit.id)
        sandbox = await self.client.sandboxes.create(packages=[memoryview(wasm)])
        self.sandboxes.append(sandbox)
        installed = await sandbox.install_package(bytearray(wasm))
        self.assertEqual(pkg.id, installed.id)
        self.assertEqual((await sandbox.command(pkg).run()).text(), "Hello from Swift!\n")
        self.assertEqual((await sandbox.command("main").run()).text(), "Hello from Swift!\n")
        for invalid in (b"\0asm\x01\0\0\0", b"\0asm\x0d\0\x01\0"):
            with self.assertRaises(WasmerError) as raised:
                await self.client.packages.load(invalid)
            self.assertEqual(raised.exception.code, "PACKAGE_LOAD_FAILED")
