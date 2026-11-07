import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { Worker } from "node:worker_threads";

import { Wasmer } from "../dist/node.js";
import { GuestMemoryBudget } from "../dist/guest-memory-budget.js";
import { obtainGarbageCollector } from "../dist/node-garbage-collector.js";
import {
  nodeWorkerGuestMemoryStats,
  nodeWorkerStats,
} from "../dist/node-worker-adapter.js";

const runtimeCache = fileURLToPath(new URL("../../.wasmer", import.meta.url));
const MiB = 1024 * 1024;

afterEach(async () => {
  delete globalThis.__wasmerGuestMemoryDiagnostics;
  await waitFor(() => nodeWorkerStats().activeWorkers === 0);
  assert.equal(nodeWorkerStats().workerFailures, 0, "a Wasmer worker crashed");
});

/**
 * Run `count` sandboxes one after another and check, after each one, that no
 * worker keeps more dead guest memory than `budget`.
 */
async function runGuests(client, count, budget) {
  const python = await client.packages.load("python/python@=3.13.20");
  let guestBytes = 0;
  for (let index = 0; index < count; index++) {
    const sandbox = await client.sandboxes.create({ packages: [python] });
    try {
      const output = await sandbox.command("python", ["-c", "print(6 * 7)"]).run();
      assert.equal(output.text().trim(), "42");
    } finally {
      await sandbox.close();
    }
    for (const worker of await nodeWorkerGuestMemoryStats()) {
      guestBytes = Math.max(guestBytes, worker.liveBytes ?? 0);
      assert.ok(
        worker.liveBytes <= budget,
        `worker ${worker.threadId} keeps ${worker.liveBytes} bytes of guest memory after guest ${index + 1}`,
      );
    }
  }
  return guestBytes;
}

test("bounds each worker's dead guest memory and frees it when idle", async () => {
  globalThis.__wasmerGuestMemoryDiagnostics = true;
  const budget = 48 * MiB;
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    guestMemoryGcBudget: budget,
  });
  try {
    await runGuests(client, 30, budget);
    const busy = await nodeWorkerGuestMemoryStats();
    const created = busy.reduce((sum, worker) => sum + worker.created, 0);
    assert.ok(created >= 30, `only ${created} guest memories were created`);
    assert.ok(
      busy.some((worker) => worker.budgetCollections > 0),
      "no worker collected on reaching the budget",
    );

    // An idle worker collects whatever it still keeps after about a second.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    for (const worker of await nodeWorkerGuestMemoryStats()) {
      assert.equal(worker.liveBytes, 0, `worker ${worker.threadId} kept guest memory while idle`);
      assert.equal(worker.released, 0);
    }
  } finally {
    await client.close();
  }
});

test("releases guest memory when back-to-back guests overlap workers", async () => {
  // A guest's exit is observable before its worker reports Idle, so the
  // next guest can start on another worker meanwhile. Both guests' main
  // threads are PID 1, TID 1; the first worker must still be told to
  // release its finished guest.
  globalThis.__wasmerGuestMemoryDiagnostics = true;
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    guestMemoryGcBudget: 1,
  });
  try {
    const hello = await client.packages.load("wasmer/hello-world@0.2.5");
    for (let index = 0; index < 6; index++) {
      const sandbox = await client.sandboxes.create({ packages: [hello] });
      try {
        assert.match((await sandbox.command("hello").run()).text(), /Hello/);
      } finally {
        await sandbox.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const workers = await nodeWorkerGuestMemoryStats();
    const sum = (key) => workers.reduce((total, worker) => total + worker[key], 0);
    // With a 1-byte budget every guest is collected as soon as its worker
    // is idle; a worker that missed its release would batch several guests
    // into one later collection.
    assert.equal(sum("created"), 6);
    assert.equal(sum("budgetCollections"), 6, JSON.stringify(workers));
    assert.equal(sum("liveBytes"), 0);
  } finally {
    await client.close();
  }
});

test("collecting guest memory does not expose gc to other code", async () => {
  globalThis.__wasmerGuestMemoryDiagnostics = true;
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    guestMemoryGcBudget: 1,
  });
  try {
    await runGuests(client, 2, Number.POSITIVE_INFINITY);
    const workers = await nodeWorkerGuestMemoryStats();
    assert.ok(
      workers.some((worker) => worker.budgetCollections > 0),
      "the workers never collected",
    );
  } finally {
    await client.close();
  }
  assert.equal(typeof globalThis.gc, "undefined");
  assert.equal(vm.runInNewContext("typeof gc"), "undefined");
  const fresh = new Worker(
    "require('node:worker_threads').parentPort.postMessage([typeof gc, require('node:vm').runInNewContext('typeof gc')])",
    { eval: true },
  );
  const [global, context] = await new Promise((resolve, reject) => {
    fresh.once("message", resolve);
    fresh.once("error", reject);
  });
  await fresh.terminate();
  assert.equal(global, "undefined");
  assert.equal(context, "undefined");
});

test("retires workers that cannot collect their guest memory", async () => {
  globalThis.__wasmerGuestMemoryDiagnostics = "no-collector";
  const budget = 48 * MiB;
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    guestMemoryGcBudget: budget,
  });
  const before = nodeWorkerStats().workersCreated;
  try {
    await runGuests(client, 12, budget);
    // Retired workers were replaced.
    assert.ok(nodeWorkerStats().workersCreated - before > 3);
  } finally {
    const started = performance.now();
    await client.close();
    assert.ok(performance.now() - started < 1_000, "close() waited on a retiring worker");
  }
});

test("a zero budget leaves guest memory to the engine", async () => {
  globalThis.__wasmerGuestMemoryDiagnostics = true;
  const client = new Wasmer({
    cache: { directory: runtimeCache },
    guestMemoryGcBudget: 0,
  });
  try {
    await runGuests(client, 3, Number.POSITIVE_INFINITY);
    for (const worker of await nodeWorkerGuestMemoryStats()) {
      assert.equal(worker.budgetCollections + worker.idleCollections, 0);
      assert.equal(worker.retirementRequests, 0);
    }
  } finally {
    await client.close();
  }
});

test("the Node collector runs a full collection without exposing gc", async () => {
  const collect = obtainGarbageCollector();
  assert.equal(typeof collect, "function");
  let target = { payload: new Uint8Array(1024) };
  const reference = new WeakRef(target);
  target = undefined;
  // WeakRef targets stay alive until the job that created them ends.
  await new Promise((resolve) => setImmediate(resolve));
  collect();
  assert.equal(reference.deref(), undefined);
  assert.equal(typeof globalThis.gc, "undefined");
  assert.equal(vm.runInNewContext("typeof gc"), "undefined");
});

test("the budget collects early enough for one more guest", () => {
  const events = [];
  let collector = () => events.push("collect");
  const budget = new GuestMemoryBudget({
    budget: 100,
    obtainCollector: () => collector,
    requestRetirement: () => events.push("retire"),
  });
  budget.release(30);
  budget.release(30);
  assert.deepEqual(events, []);
  assert.equal(budget.released, 60);
  // 90 + one more guest of 30 would exceed 100.
  budget.release(30);
  assert.deepEqual(events, ["collect"]);
  assert.equal(budget.released, 0);
  assert.equal(budget.stats.budgetCollections, 1);
});

test("without a collector the budget asks once per idle period to retire", () => {
  const events = [];
  const budget = new GuestMemoryBudget({
    budget: 100,
    obtainCollector: () => null,
    requestRetirement: () => events.push("retire"),
  });
  // A request can cross one more guest on its way to this worker: ask while
  // there is room for two.
  budget.release(30);
  assert.deepEqual(events, []);
  budget.release(30);
  assert.deepEqual(events, ["retire"]);
  budget.release(0);
  assert.deepEqual(events, ["retire"], "asked again before getting work");
  // The pool gave the worker more work instead: ask again afterwards.
  budget.blockingTaskStarted();
  budget.blockingTaskFinished();
  budget.release(30);
  assert.deepEqual(events, ["retire", "retire"]);
});

const bun = spawnSync("bun", ["--version"]).status === 0;

test(
  "Bun workers collect guest memory with Bun.gc()",
  { skip: bun ? false : "bun is not installed" },
  async () => {
    await promisify(execFile)(
      "bun",
      [
        fileURLToPath(new URL("./support/guest-memory-bun.mjs", import.meta.url)),
        runtimeCache,
      ],
      { timeout: 120_000 },
    );
  },
);

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      assert.fail("timed out waiting for Wasmer workers");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
