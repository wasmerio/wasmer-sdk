import { Wasmer } from "@wasmer/sdk/node";

const client = new Wasmer();
const sandbox = await client.createSandbox({
  packages: ["python/python@3.12"],
});

const output = await sandbox
  .command("python", ["--version"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.close();
