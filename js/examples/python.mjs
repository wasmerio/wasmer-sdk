import { readFile } from "node:fs/promises";

import { Wasmer } from "@wasmer/sdk2/node";

const source = await readFile(
  new URL("../../fixtures/python/hello.py", import.meta.url),
);

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["python/python@3.13.5"],
  files: { "hello.py": source },
});

try {
  const output = await sandbox
    .command("python", ["/workspace/hello.py"])
    .run();

  console.log(output.text().trim());
} finally {
  await sandbox.close();
  await wasmer.close();
}
