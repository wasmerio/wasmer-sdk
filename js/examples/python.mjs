import { readFile } from "node:fs/promises";

import { Wasmer } from "@wasmer/sdk2/node";

const source = await readFile(
  new URL("../../fixtures/python/hello.py", import.meta.url),
);

const client = new Wasmer();
const sandbox = await client.sandboxes.create({
  packages: ["python/python@3.13.5"],
  files: { "hello.py": source },
});

try {
  const output = await sandbox
    .command("python", ["/workspace/hello.py"])
    .run({ check: true });

  console.log(output.text().trim());
} finally {
  await sandbox.close();
  await client.close();
}
