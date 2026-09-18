import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import test from "node:test";
import { isHostFileSystemRequest, respondToHostFileSystem } from "../dist/host-filesystem.js";

test("native filesystem RPC wakes a blocked worker with bytes and structured errors", { timeout: 10_000 }, async () => {
  const moduleURL = new URL("../dist/host-filesystem.js", import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import { installHostFileSystemWorkerBridge } from ${JSON.stringify(moduleURL)};
    globalThis.postMessage = value => parentPort.postMessage(value);
    installHostFileSystemWorkerBridge();
    const read = globalThis.__wasmerHostFileSystem(1, 'read', [7, 0, 4]);
    const failures = [];
    for (const method of ['denied', 'oversized']) {
      try { globalThis.__wasmerHostFileSystem(1, method, []); }
      catch (error) { failures.push({code: error.code, message: error.message}); }
    }
    parentPort.postMessage({done: true, read, failures});
  `)}`));
  try {
    const finished = new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => {
        if (!isHostFileSystemRequest(message)) { resolve(message); return; }
        if (message.method === "read") respondToHostFileSystem(message, { value: [0, 128, 255, 10] });
        else if (message.method === "denied") respondToHostFileSystem(message, { error: { code: "EACCES", message: "read only" } });
        else respondToHostFileSystem(message, { value: "x".repeat(600_000) });
      });
    });
    const exit = once(worker, "exit");
    const result = await finished;
    assert.deepEqual(result.read, [0, 128, 255, 10]);
    assert.deepEqual(result.failures.map(error => error.code), ["EACCES", "EIO"]);
    assert.match(result.failures[1].message, /exceeds bridge limit/);
    assert.deepEqual(await exit, [0]);
  } finally {
    await worker.terminate();
  }
});
