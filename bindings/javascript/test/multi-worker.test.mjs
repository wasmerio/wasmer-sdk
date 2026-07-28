import assert from "node:assert/strict";
import test from "node:test";

import { Wasmer } from "../dist/node.js";
import { nodeWorkerStats } from "../dist/node-worker-adapter.js";

test("runs blocking WASIX processes concurrently on separate workers", async () => {
  const client = new Wasmer();
  const sandbox = await client.createSandbox({
    packages: ["python/python@3.12"],
  });

  try {
    const first = await sandbox
      .command("python", ["--version"])
      .spawn({ stdout: "capture", stderr: "capture" });
    const second = await sandbox
      .command("python", ["--version"])
      .spawn({ stdout: "capture", stderr: "capture" });

    const [firstOutput, secondOutput] = await Promise.all([
      first.wait({ check: true }),
      second.wait({ check: true }),
    ]);

    assert.match(firstOutput.text(), /^Python 3\./);
    assert.match(secondOutput.text(), /^Python 3\./);
    assert.ok(nodeWorkerStats().workersCreated >= 2);
  } finally {
    await sandbox.close();
    await client.close();
  }
});
