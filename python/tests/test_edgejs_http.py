import asyncio
import socket
import unittest
import urllib.request
from pathlib import Path

from wasmer_sdk import ExitReason, Wasmer


REPOSITORY = Path(__file__).resolve().parents[2]
SERVER_SOURCE = REPOSITORY / "fixtures/edgejs/server.js"
RESPONSE_MARKER = "<h1>Hello from Edge.js!</h1>"


class EdgeJsHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_serves_http_over_host_networking(self) -> None:
        port = reserve_port()
        client = Wasmer(output_bytes=256 * 1024)
        sandbox = None
        process = None
        try:
            edgejs = await client.packages.load("wasmer/edgejs@0.2.0")
            sandbox = await client.sandboxes.create(
                packages=[edgejs],
                files={"server.js": SERVER_SOURCE.read_bytes()},
                env={"PORT": str(port)},
                network="host",
            )
            process = await sandbox.command(
                edgejs, ["/workspace/server.js"]
            ).spawn(
                stdout="pipe",
                stderr="capture",
                output_bytes=256 * 1024,
            )
            stdout = process.stdout
            self.assertIsNotNone(stdout)
            assert stdout is not None
            await asyncio.wait_for(
                wait_for_line(stdout.lines(), "Edge.js listening on"),
                timeout=20,
            )
            status, body = await asyncio.wait_for(
                asyncio.to_thread(fetch, port),
                timeout=10,
            )
            self.assertEqual(status, 200)
            self.assertIn(RESPONSE_MARKER, body)
            await asyncio.wait_for(
                process.terminate(grace_period=2),
                timeout=5,
            )
            output = await asyncio.wait_for(process.wait(), timeout=5)
            self.assertEqual(output.reason, ExitReason.TERMINATED)
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


def fetch(port: int) -> tuple[int, str]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/hello",
        headers={"Connection": "close"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, response.read().decode()


def reserve_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]
