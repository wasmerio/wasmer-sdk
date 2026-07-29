import { Wasmer } from "@wasmer/sdk/node";

const client = new Wasmer();
const python = await client.packages.load("python/python@3.13.5");
const sandbox = await client.sandboxes.create({
  packages: [python],
});

const output = await sandbox
  .command("python", ["--version"])
  .run({ check: true });

console.log(output.text());

await sandbox.close();
await client.close();
