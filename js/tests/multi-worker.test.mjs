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

test("runs back-to-back guests on the worker that just finished", async () => {
  // A guest's exit is observable (run() and close() resolve) shortly before
  // its worker reports Idle. The next guest must wait for that worker rather
  // than start another one: alternating workers each keep their own dead
  // guest memories (wasmer-sdk#547).
  const created = [];
  const error = console.error;
  globalThis.__wasmerSchedulerDiagnostics = true;
  // A loaded machine can stall the finished worker; the bound is not what
  // this test is about.
  globalThis.__wasmerDrainWaitMs = 10_000;
  console.error = (...args) => {
    const line = args.join(" ");
    const match = /\[wasmer-scheduler\] create worker=(\d+) reason=wasm-/.exec(line);
    if (match) created.push(Number(match[1]));
    else if (!line.includes("[wasmer-scheduler]")) error(...args);
  };
  const client = new Wasmer({ cache: { directory: runtimeCache } });
  try {
    const hello = await client.packages.load("wasmer/hello-world@0.2.5");
    for (let index = 0; index < 12; index++) {
      const sandbox = await client.sandboxes.create({ packages: [hello] });
      try {
        const output = await sandbox.command("hello").run();
        assert.match(output.text(), /Hello from Wasmer/);
      } finally {
        await sandbox.close();
      }
    }
    assert.equal(created.length, 1, `guests started workers ${created}`);
  } finally {
    console.error = error;
    delete globalThis.__wasmerSchedulerDiagnostics;
    delete globalThis.__wasmerDrainWaitMs;
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
