import asyncio
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from wasmer_sdk import ExitReason, Wasmer


PSQL = os.environ.get("PSQL") or shutil.which("psql")
PORT = 5432
QUERY = (
    Path(__file__).resolve().parents[2]
    / "fixtures/postgres/query.sql"
)


class PostgresPsqlTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_psql_connects_to_wasix_postgres(self) -> None:
        if not PSQL:
            self.skipTest("set PSQL or install psql on PATH")

        client = Wasmer(output_bytes=256 * 1024)
        sandbox = None
        process = None
        try:
            pglite = await client.packages.load("wasmer/pglite@0.1.0")
            self.assertEqual(pglite.entrypoint, "pglite")
            self.assertIn("pglite", pglite.commands)
            sandbox = await client.sandboxes.create(
                packages=[pglite],
                network="host",
            )
            process = await sandbox.command(pglite).spawn(
                stdout="capture",
                stderr="pipe",
                output_bytes=256 * 1024,
            )
            stderr = process.stderr
            self.assertIsNotNone(stderr)
            assert stderr is not None
            marker = f"OLIPHAUNT_WASIX_SOCKET_READY {PORT}"
            await asyncio.wait_for(
                wait_for_line(stderr.lines(), marker),
                timeout=30,
            )
            result = await asyncio.wait_for(
                asyncio.to_thread(run_psql, PORT),
                timeout=15,
            )
            if result.returncode != 0:
                self.fail(
                    "psql failed with "
                    f"{result.returncode}\nstdout:\n{result.stdout}"
                    f"\nstderr:\n{result.stderr}"
                )
            self.assertRegex(
                result.stdout,
                r"(?m)wasm32-unknown-wasix.*\|42$",
            )
            output = await asyncio.wait_for(
                process.wait(check=True),
                timeout=10,
            )
            self.assertEqual(output.exit_code, 0)
            self.assertEqual(output.reason, ExitReason.EXITED)
        finally:
            if process is not None:
                await process.kill()
                await process.wait()
            if sandbox is not None:
                await sandbox.close()
            await client.close()


async def wait_for_line(lines, marker: str) -> str:
    async for line in lines:
        if marker in line:
            return line
    raise RuntimeError(f"process exited before emitting {marker!r}")


def run_psql(port: int) -> subprocess.CompletedProcess[str]:
    uri = (
        f"postgresql://postgres@127.0.0.1:{port}/"
        "postgres?sslmode=disable"
    )
    return subprocess.run(
        [
            str(PSQL),
            uri,
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-At",
            "-f",
            str(QUERY),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
