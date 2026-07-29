import asyncio

import wasmer_sdk_boltffi_native as sdk


async def main() -> None:
    client = sdk.Wasmer(None, 16 * 1024 * 1024)
    sandbox = await client.create_sandbox(
        ["python/python@3.12"],
        {"main.py": b"print('hello from BoltFFI')"},
        {},
        sdk.NetworkMode.DISABLED,
    )
    command = sandbox.command(
        "python",
        ["/workspace/main.py"],
        None,
        {},
    )
    output = await command.run(sdk.RunOptions(None, 30_000, None))
    assert output.exit_code == 0, bytes(output.stderr).decode()
    print(bytes(output.stdout).decode().strip())

    await sandbox.close()


asyncio.run(main())
