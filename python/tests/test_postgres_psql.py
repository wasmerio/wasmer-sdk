import asyncio
import os
import shutil
import socket
import subprocess
import unittest
from pathlib import Path

from wasmer_sdk import ExitReason, Wasmer


POSTGRES_PACKAGE = os.environ.get(
    "WASMER_POSTGRES_PACKAGE",
    os.environ.get("WASMER_POSTGRES_WEBC"),
)
PSQL = os.environ.get("PSQL") or shutil.which("psql")


class PostgresPsqlTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_psql_connects_to_wasix_postgres(self) -> None:
        if not POSTGRES_PACKAGE:
            self.skipTest(
                "set WASMER_POSTGRES_PACKAGE or WASMER_POSTGRES_WEBC"
            )
        package_path = Path(POSTGRES_PACKAGE)
        if not package_path.exists():
            self.skipTest(f"PostgreSQL package does not exist: {package_path}")
        if not PSQL:
            self.skipTest("set PSQL or install psql on PATH")

        port = reserve_port()
        client = Wasmer(output_bytes=256 * 1024)
        sandbox = None
        process = None
        try:
            postgres = await client.packages.load(package_path)
            sandbox = await client.sandboxes.create(
                packages=[postgres],
                network="host",
                env={
                    "OLIPHAUNT_WASIX_SOCKET_PORT": str(port),
                    "PREFIX": "/",
                    "PGDATA": "/base",
                    "PGUSER": "postgres",
                    "PGDATABASE": "postgres",
                    "PGSYSCONFDIR": "/base",
                    "PGCLIENTENCODING": "UTF8",
                    "LC_CTYPE": "C.UTF-8",
                    "TZ": "UTC",
                    "PGTZ": "UTC",
                    "PG_COLOR": "never",
                },
            )
            process = await sandbox.command(
                postgres,
                [
                    "--single",
                    "-F",
                    "-O",
                    "-j",
                    "-c",
                    "io_method=sync",
                    "-D",
                    "/base",
                    "postgres",
                ],
                cwd="/",
            ).spawn(
                stdout="capture",
                stderr="pipe",
                output_bytes=256 * 1024,
            )
            stderr = process.stderr
            self.assertIsNotNone(stderr)
            assert stderr is not None
            marker = f"OLIPHAUNT_WASIX_SOCKET_READY {port}"
            await asyncio.wait_for(
                wait_for_line(stderr.lines(), marker),
                timeout=30,
            )
            result = await asyncio.wait_for(
                asyncio.to_thread(run_psql, port),
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
            "-c",
            "select version(), 40 + 2 as answer;",
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def reserve_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]
