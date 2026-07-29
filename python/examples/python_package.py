import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    client = Wasmer()
    sandbox = await client.create_sandbox(
        packages=["python/python@3.13.5"],
        files={"main.py": "print(sum(n * n for n in range(10)))"},
    )
    output = await sandbox.command(
        "python", ["/workspace/main.py"]
    ).run(check=True, timeout=10)
    print(output.text().strip())


asyncio.run(main())
