import argparse
import asyncio
import shutil
import subprocess

from wasmer_sdk import Wasmer

PORT = 5432


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run PostgreSQL under Wasmer and query it with native psql"
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


async def main() -> None:
    args = arguments()
    if not args.psql:
        raise SystemExit("psql was not found; install it or pass --psql")

    async with Wasmer(output_bytes=256 * 1024) as client:
        pglite = await client.packages.load("wasmer/pglite@0.1.0")
        sandbox = await client.sandboxes.create(
            packages=[pglite],
            network="host",
        )
        async with sandbox:
            process = await sandbox.command(pglite).spawn(
                stdout="capture",
                stderr="pipe",
                output_bytes=256 * 1024,
            )
            assert process.stderr is not None

            try:
                await asyncio.wait_for(
                    wait_for_line(
                        process.stderr.lines(),
                        f"OLIPHAUNT_WASIX_SOCKET_READY {PORT}",
                    ),
                    timeout=30,
                )
                result = await asyncio.to_thread(query, args.psql, PORT)
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
