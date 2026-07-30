import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Wasmer } from "../dist/node.js";
import { nodeWorkerStats } from "../dist/node-worker-adapter.js";

const runtimeCache = fileURLToPath(new URL("../../.wasmer", import.meta.url));

test("runs blocking WASIX processes concurrently on separate workers", async () => {
  const client = new Wasmer({ cache: { directory: runtimeCache } });
  const hello = await client.packages.load("wasmer/hello-world@0.2.5");
  const sandbox = await client.sandboxes.create({
    packages: [hello],
  });

  try {
    const first = await sandbox
      .command("hello")
      .spawn({ stdout: "capture", stderr: "capture" });
    const second = await sandbox
      .command("hello")
      .spawn({ stdout: "capture", stderr: "capture" });

    const [firstOutput, secondOutput] = await Promise.all([
      first.wait({ check: true }),
      second.wait({ check: true }),
    ]);

    assert.match(firstOutput.text(), /Hello from Wasmer/);
    assert.match(secondOutput.text(), /Hello from Wasmer/);
    assert.ok(nodeWorkerStats().workersCreated >= 2);
  } finally {
    await sandbox.close();
    await client.close();
    await waitFor(() => nodeWorkerStats().activeWorkers === 0);
  }
});

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      assert.fail("timed out waiting for Wasmer workers to stop");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
