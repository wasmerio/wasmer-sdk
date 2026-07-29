import unittest

try:
    import wasmer_sdk_boltffi_native as sdk
except ModuleNotFoundError:
    sdk = None


@unittest.skipIf(sdk is None, "BoltFFI prototype wheel is not installed")
class NativeBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = sdk.Wasmer(None, 256 * 1024)
        self.sandbox = await self.client.create_sandbox(
            ["python/python@3.12"],
            {"main.py": b"print('hello from BoltFFI test')"},
            {},
            sdk.NetworkMode.DISABLED,
        )

    async def asyncTearDown(self) -> None:
        await self.sandbox.close()
        await self.client.close()

    async def test_package_command_and_filesystem(self) -> None:
        output = await self.sandbox.command(
            "python",
            ["/workspace/main.py"],
            None,
            {},
        ).run(sdk.RunOptions(None, 10_000, None))

        self.assertEqual(output.exit_code, 0)
        self.assertEqual(
            bytes(output.stdout).decode().strip(),
            "hello from BoltFFI test",
        )

        filesystem = self.sandbox.filesystem()
        await filesystem.write("note.txt", b"hello")
        self.assertEqual(bytes(await filesystem.read("note.txt")), b"hello")

    async def test_process_streams(self) -> None:
        process = await self.sandbox.command(
            "python",
            ["-u", "-c", "print(input().upper())"],
            None,
            {},
        ).spawn(
            sdk.SpawnOptions(
                10_000,
                None,
                sdk.InputMode.PIPE,
                sdk.OutputMode.PIPE,
                sdk.OutputMode.DISCARD,
            )
        )
        await process.write_stdin(b"hello\n")
        await process.close_stdin()
        chunks = []
        while chunk := await process.read_stdout(64 * 1024):
            chunks.append(bytes(chunk))
        self.assertEqual(b"".join(chunks), b"HELLO\n")
        self.assertEqual((await process.wait()).exit_code, 0)


if __name__ == "__main__":
    unittest.main()
