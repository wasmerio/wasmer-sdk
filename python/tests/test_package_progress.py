import asyncio
from pathlib import Path
import tempfile
import threading
import unittest

from wasmer_sdk import DownloadProgress, PackageLoadPhase, Wasmer

FIXTURE = Path(__file__).resolve().parents[2] / "swift/Tests/WasmerSDKTests/Fixtures/hello.wasm"


class PackageProgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cache = tempfile.TemporaryDirectory()
        self.client = Wasmer(cache_root=self.cache.name)

    async def asyncTearDown(self):
        await self.client.close()
        self.cache.cleanup()

    async def test_final_snapshot_on_event_loop_before_return(self):
        updates = []
        thread = threading.get_ident()

        def progress(snapshot):
            self.assertEqual(threading.get_ident(), thread)
            self.assertIs(asyncio.get_running_loop(), asyncio.get_event_loop())
            updates.append(snapshot)

        packages = await self.client.packages.load_many([FIXTURE.read_bytes(), FIXTURE.read_bytes()], on_progress=progress)
        self.assertEqual(packages[0].id, packages[1].id)
        self.assertEqual(updates[-1].phase, PackageLoadPhase.READY)
        self.assertEqual(updates[-1].download, DownloadProgress(0, 0, 100))
        self.assertEqual(len(updates[-1].packages), 1)
        sandbox = await self.client.sandboxes.create(packages=packages, on_package_progress=progress)
        try:
            self.assertTrue(updates[-1].packages[0].cached)
            await sandbox.install_package(packages[0], on_progress=progress)
            self.assertEqual(updates[-1].phase, PackageLoadPhase.READY)
        finally:
            await sandbox.close()
        count = len(updates)
        await asyncio.sleep(0.02)
        self.assertEqual(len(updates), count)

    async def test_callback_exception_is_reported_once_and_does_not_fail_load(self):
        loop = asyncio.get_running_loop()
        errors = []
        previous = loop.get_exception_handler()
        loop.set_exception_handler(lambda _, context: errors.append(context))
        calls = []

        def broken(progress):
            calls.append(progress)
            raise ValueError("observer test")

        try:
            package = await self.client.packages.load(FIXTURE.read_bytes(), on_progress=broken)
            self.assertEqual(package.entrypoint, "main")
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(errors), 1)
        finally:
            loop.set_exception_handler(previous)

    async def test_empty_batch_and_cancelled_task(self):
        updates = []
        self.assertEqual(await self.client.packages.load_many([], on_progress=updates.append), [])
        self.assertEqual(updates[-1].phase, PackageLoadPhase.READY)
        task = asyncio.create_task(self.client.packages.load(FIXTURE.read_bytes(), on_progress=updates.append))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
