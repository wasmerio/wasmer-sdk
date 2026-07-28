import { Wasmer } from "@wasmer/sdk/node";

await using wasmer = await Wasmer.create();
await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
});

const output = await sandbox
  .command("python", ["--version"])
  .run({ check: true });

console.log(output.text());
