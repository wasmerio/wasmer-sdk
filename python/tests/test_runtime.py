import unittest

from wasmer_sdk import ExitReason, ProcessExitError, Wasmer, WasmerError


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = Wasmer(output_bytes=256 * 1024)
        self.assertTrue(callable(self.client.packages.load))
        self.assertTrue(callable(self.client.sandboxes.create))
        python = await self.client.packages.load("python/python@=3.13.18")
        self.sandbox = await self.client.sandboxes.create(
            packages=[python],
            files={"main.py": "print('hello from python binding')"},
            env={"SDK_TEST": "sandbox"},
        )

    async def asyncTearDown(self) -> None:
        await self.sandbox.close()
        await self.client.close()

    async def test_captured_command_and_filesystem(self) -> None:
        output = await self.sandbox.command(
            "python", ["/workspace/main.py"]
        ).run(timeout=10)
        self.assertEqual(output.text().strip(), "hello from python binding")
        self.assertEqual(output.reason, ExitReason.EXITED)

        await self.sandbox.fs.write_text("nested/original.txt", "hello")
        await self.sandbox.fs.rename(
            "nested/original.txt", "nested/renamed.txt"
        )
        self.assertEqual(
            await self.sandbox.fs.read_text("nested/renamed.txt"), "hello"
        )
        self.assertEqual(
            [entry.name for entry in await self.sandbox.fs.read_dir("nested")],
            ["renamed.txt"],
        )

    async def test_stream_iteration_and_reusable_command(self) -> None:
        command = self.sandbox.command("python", ["--version"])
        self.assertRegex((await command.run()).text(), r"^Python 3\.")
        self.assertRegex((await command.run()).text(), r"^Python 3\.")

        process = await command.spawn(stderr="discard")
        self.assertIsNotNone(process.stdout)
        lines = [line async for line in process.stdout.lines()]
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^Python 3\.")
        self.assertTrue((await process.wait(check=True)).ok)

    async def test_stdin_and_dynamic_install(self) -> None:
        installed = await self.sandbox.install_package("python/python@=3.13.18")
        self.assertIn("python", installed.commands)

        process = await self.sandbox.command(
            installed,
            ["-u", "-c", "print(input().upper())"],
        ).spawn(stdin="pipe", stderr="discard")
        self.assertIsNotNone(process.stdin)
        self.assertIsNotNone(process.stdout)
        await process.stdin.write("hello\n")
        await process.stdin.close()
        lines = [line async for line in process.stdout.lines()]
        self.assertEqual(lines, ["HELLO"])
        self.assertTrue((await process.wait(check=True)).ok)

    async def test_termination(self) -> None:
        blocked = await self.sandbox.command("python").spawn(
            stdin="pipe",
            stdout="discard",
            stderr="discard",
        )
        await blocked.terminate(grace_period=0.1)
        self.assertEqual((await blocked.wait()).reason, ExitReason.TERMINATED)

    async def test_checked_failure_and_timeout(self) -> None:
        command = self.sandbox.command(
            "python",
            [
                "-c",
                "import sys; print('intentional', file=sys.stderr); sys.exit(7)",
            ],
        )
        with self.assertRaises(ProcessExitError) as raised:
            await command.run()
        self.assertEqual(raised.exception.output.exit_code, 7)
        self.assertIn("intentional", str(raised.exception))

        unchecked = await command.run(check=False)
        self.assertEqual(unchecked.exit_code, 7)
        self.assertEqual(unchecked.reason, ExitReason.EXITED)

        blocked = await self.sandbox.command("python").spawn(
            timeout=0.05,
            stdin="pipe",
            stdout="discard",
            stderr="discard",
        )
        self.assertEqual((await blocked.wait()).reason, ExitReason.TIMEOUT)


class ValidationTests(unittest.TestCase):
    def test_numeric_inputs(self) -> None:
        for value in (-1, 1.5, True):
            with self.assertRaises(WasmerError) as raised:
                Wasmer(output_bytes=value)
            self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")
