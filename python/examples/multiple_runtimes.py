import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    client = Wasmer()
    sandbox = await client.sandboxes.create(
        packages=[
            "python/python",
            "wasmer/edgejs-quickjs",
            "php/php-32",
        ]
    )

    commands = [
        ("echo", ["hello from shell tools"]),
        ("python", ["-c", "print('hello from Python')"]),
        ("edge", ["-e", 'console.log("hello from Edge.js")']),
        ("php", ["-r", "echo 'hello from PHP';"]),
    ]

    try:
        for executable, args in commands:
            output = await sandbox.command(executable, args).run(check=True)
            print(output.text().strip())
    finally:
        await sandbox.close()
        await client.close()


asyncio.run(main())
