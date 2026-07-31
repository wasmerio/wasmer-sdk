import asyncio
import socket
import urllib.request
from pathlib import Path

from wasmer_sdk import Wasmer


SERVER_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "fixtures/edgejs/server.js"
)


async def wait_for_line(lines, marker: str) -> None:
    async for line in lines:
        print(line)
        if marker in line:
            return
    raise RuntimeError(f"EdgeJS exited before emitting {marker!r}")


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


async def main() -> None:
    port = reserve_port()

    async with Wasmer(output_bytes=256 * 1024) as client:
        sandbox = await client.sandboxes.create(
            packages=["wasmer/edgejs-quickjs@0.1.0"],
            files={"server.js": SERVER_SOURCE.read_bytes()},
            env={"PORT": str(port)},
            network="host",
        )
        async with sandbox:
            process = await sandbox.command(
                "edge",
                ["/workspace/server.js"],
            ).spawn(
                stdout="pipe",
                stderr="capture",
                output_bytes=256 * 1024,
            )
            assert process.stdout is not None

            try:
                await asyncio.wait_for(
                    wait_for_line(
                        process.stdout.lines(),
                        "Edge.js listening on",
                    ),
                    timeout=20,
                )
                status, body = await asyncio.to_thread(fetch, port)
                print(f"GET /hello -> {status}")
                print(body)
            finally:
                await process.terminate(grace_period=2)
                await process.wait()


if __name__ == "__main__":
    asyncio.run(main())
