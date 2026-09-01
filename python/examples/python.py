import asyncio
from pathlib import Path

from wasmer_sdk import Wasmer


SOURCE = (
    Path(__file__).resolve().parents[2]
    / "fixtures/python/hello.py"
)


async def main() -> None:
    wasmer = Wasmer()
    sandbox = await wasmer.sandboxes.create(
        packages=["python/python@=3.13.18"],
        files={"hello.py": SOURCE.read_bytes()},
    )
    output = await sandbox.command(
        "python", ["/workspace/hello.py"]
    ).run()
    print(output.text().strip())


asyncio.run(main())
