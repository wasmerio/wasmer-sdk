import asyncio

from wasmer_sdk import Wasmer


async def main() -> None:
    wasmer = Wasmer()
    sandbox = await wasmer.sandboxes.create(
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

    for executable, args in commands:
        output = await sandbox.command(executable, args).run()
        print(output.text().strip())


asyncio.run(main())
