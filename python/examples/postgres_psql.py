import argparse
import asyncio
import shutil
import socket
import subprocess
from pathlib import Path

from wasmer_sdk import Wasmer


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run PostgreSQL under Wasmer and query it with native psql"
    )
    parser.add_argument(
        "package",
        type=Path,
        help="path to a WASIX PostgreSQL WEBC package",
    )
    parser.add_argument(
        "--psql",
        default=shutil.which("psql"),
        help="path to the native psql client (defaults to PATH)",
    )
    return parser.parse_args()


async def wait_for_line(lines, marker: str) -> None:
    async for line in lines:
        print(line)
        if marker in line:
            return
    raise RuntimeError(f"PostgreSQL exited before emitting {marker!r}")


def query(psql: str, port: int) -> subprocess.CompletedProcess[str]:
    uri = (
        f"postgresql://postgres@127.0.0.1:{port}/"
        "postgres?sslmode=disable"
    )
    return subprocess.run(
        [
            psql,
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


async def main() -> None:
    args = arguments()
    if not args.package.is_file():
        raise SystemExit(f"PostgreSQL package not found: {args.package}")
    if not args.psql:
        raise SystemExit("psql was not found; install it or pass --psql")

    port = reserve_port()
    async with Wasmer(output_bytes=256 * 1024) as client:
        postgres = await client.packages.load(args.package)
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
        async with sandbox:
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
            assert process.stderr is not None

            try:
                await asyncio.wait_for(
                    wait_for_line(
                        process.stderr.lines(),
                        f"OLIPHAUNT_WASIX_SOCKET_READY {port}",
                    ),
                    timeout=30,
                )
                result = await asyncio.to_thread(query, args.psql, port)
                if result.returncode != 0:
                    raise RuntimeError(
                        f"psql exited with {result.returncode}\n"
                        f"{result.stderr}"
                    )
                print(result.stdout.strip())
                await asyncio.wait_for(
                    process.wait(check=True),
                    timeout=10,
                )
            finally:
                await process.kill()
                await process.wait()


if __name__ == "__main__":
    asyncio.run(main())
