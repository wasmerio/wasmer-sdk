import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { Wasmer } from "../dist/node.js";
import { nodeWorkerStats } from "../dist/node-worker-adapter.js";

const runtimeCache = fileURLToPath(new URL("../../.wasmer", import.meta.url));

afterEach(async () => {
  await waitFor(() => nodeWorkerStats().activeWorkers === 0);
  assert.equal(nodeWorkerStats().workerFailures, 0, "a Wasmer worker crashed");
});

test("workerPerThread retires each guest's worker and closes promptly", async () => {
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    workerPerThread: true,
  });
  const before = nodeWorkerStats().workersCreated;
  try {
    const hello = await client.packages.load("wasmer/hello-world@0.2.5");
    for (let index = 0; index < 10; index++) {
      const sandbox = await client.sandboxes.create({ packages: [hello] });
      try {
        const output = await sandbox.command("hello").run();
        assert.match(output.text(), /Hello from Wasmer/);
      } finally {
        await sandbox.close();
      }
    }
    // Each guest got a dedicated worker, which stopped once its thread
    // exited: at most the last guest's worker and the timer worker remain.
    assert.ok(nodeWorkerStats().workersCreated - before >= 10);
    await waitFor(() => nodeWorkerStats().activeWorkers <= 2);
  } finally {
    const started = performance.now();
    await client.close();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `close() took ${elapsed.toFixed(0)} ms`);
  }
});

test("workerPerThread runs multi-threaded guests correctly", async () => {
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    workerPerThread: true,
  });
  try {
    const sandbox = await client.sandboxes.create({
      packages: ["python/python@=3.13.20"],
    });
    try {
      const output = await sandbox
        .command("python", [
          "-c",
          [
            "import threading",
            "results = [0] * 4",
            "def work(index):",
            "    results[index] = sum(range(index * 250000, (index + 1) * 250000))",
            "threads = [threading.Thread(target=work, args=(index,)) for index in range(4)]",
            "for thread in threads: thread.start()",
            "for thread in threads: thread.join()",
            "print(sum(results))",
          ].join("\n"),
        ])
        .run();
      assert.equal(output.exitCode, 0, output.stderr.text());
      assert.equal(output.text().trim(), String((999_999 * 1_000_000) / 2));
    } finally {
      await sandbox.close();
    }
  } finally {
    await client.close();
  }
});

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      assert.fail("timed out waiting for Wasmer workers");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
