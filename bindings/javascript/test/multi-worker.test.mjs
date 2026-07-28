import assert from "node:assert/strict";
import test from "node:test";

import { Wasmer } from "../dist/node.js";
import { nodeWorkerStats } from "../dist/node-worker-adapter.js";

test("runs blocking WASIX processes concurrently on separate workers", async () => {
  const wasmer = await Wasmer.create();
  const sandbox = await wasmer.createSandbox({
    packages: ["python/python@3.12"],
  });

  try {
    const first = await sandbox
      .command("python", ["--version"])
      .spawn();
    const second = await sandbox
      .command("python", ["--version"])
      .spawn();

    const [firstOutput, secondOutput] = await Promise.all([
      first.wait({ check: true }),
      second.wait({ check: true }),
    ]);

    assert.match(firstOutput.text(), /^Python 3\./);
    assert.match(secondOutput.text(), /^Python 3\./);
    assert.ok(nodeWorkerStats().workersCreated >= 2);
  } finally {
    await sandbox.close();
    await wasmer.shutdown();
  }
});
