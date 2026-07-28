import assert from "node:assert/strict";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

test("runs a registry WASIX package in the wasm-bindgen runtime", async () => {
  const client = new Wasmer();
  const sandbox = await client.createSandbox({
    packages: ["python/python@3.12"],
  });
  const output = await sandbox.command("python", ["--version"]).run({
    check: true,
  });
  assert.match(output.text(), /^Python 3\./);
  await sandbox.close();
  await client.shutdown();
});

test("keeps Wasmer.create as an eager compatibility factory", async () => {
  const client = await Wasmer.create();
  assert.equal(await client.ready(), client);
  await client.shutdown();
});
