import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    client = Wasmer()
    python = await client.packages.load("python/python@3.13.5")
    sandbox = await client.sandboxes.create(
        packages=[python],
        files={"main.py": "print(sum(n * n for n in range(10)))"},
    )
    output = await sandbox.command(
        "python", ["/workspace/main.py"]
    ).run(check=True, timeout=10)
    print(output.text().strip())


asyncio.run(main())
