import assert from "node:assert/strict";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

test("runs a registry WASIX package in the wasm-bindgen runtime", async () => {
  const wasmer = await Wasmer.create();
  const sandbox = await wasmer.createSandbox({
    packages: ["python/python@3.12"],
  });
  const output = await sandbox.command("python", ["--version"]).run({
    check: true,
  });
  assert.match(output.text(), /^Python 3\./);
  await sandbox.close();
  await wasmer.shutdown();
});
