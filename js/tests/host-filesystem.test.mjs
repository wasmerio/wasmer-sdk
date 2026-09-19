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

test("metadata storms reuse reply storage without mixing responses", { timeout: 15_000 }, async () => {
  const moduleURL = new URL("../dist/host-filesystem.js", import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import { installHostFileSystemWorkerBridge } from ${JSON.stringify(moduleURL)};
    let allocations = 0;
    globalThis.SharedArrayBuffer = new Proxy(SharedArrayBuffer, {
      construct(target, args) { allocations++; return Reflect.construct(target, args); }
    });
    globalThis.postMessage = value => parentPort.postMessage(value);
    installHostFileSystemWorkerBridge();
    for (let i = 0; i < 5000; i++) {
      const result = globalThis.__wasmerHostFileSystem(1, 'stat', [i]);
      if (result !== i) throw new Error('Stale response: ' + result + ' instead of ' + i);
    }
    parentPort.postMessage({done: true, allocations});
  `)}`));
  try {
    const result = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => {
        if (!isHostFileSystemRequest(message)) { resolve(message); return; }
        respondToHostFileSystem(message, { value: message.args[0] });
      });
    });
    assert.equal(result.allocations, 1, "sequential filesystem calls must share one reply buffer");
  } finally {
    await worker.terminate();
  }
});

test("timed-out reply storage is quarantined and stale notifications are ignored", async () => {
  const { installHostFileSystemWorkerBridge } = await import("../dist/host-filesystem.js");
  const previousPost = globalThis.postMessage;
  const previousWait = Atomics.wait;
  let request;
  let expired;
  let notifications = 0;
  try {
    globalThis.postMessage = value => { request = value; };
    installHostFileSystemWorkerBridge();
    Atomics.wait = () => "timed-out";
    assert.throws(() => globalThis.__wasmerHostFileSystem(1, "stat", ["old"]), { code: "ETIMEDOUT" });
    expired = request;
    Atomics.wait = () => {
      notifications++;
      if (notifications === 1) {
        // The expired call finishes after the next call has already begun.
        respondToHostFileSystem(expired, { value: "old" });
        return "ok";
      }
      respondToHostFileSystem(request, { value: "new" });
      return "ok";
    };
    assert.equal(globalThis.__wasmerHostFileSystem(1, "stat", ["new"]), "new");
    assert.notEqual(request.response, expired.response);
    assert.equal(notifications, 2);
  } finally {
    Atomics.wait = previousWait;
    if (previousPost === undefined) delete globalThis.postMessage;
    else globalThis.postMessage = previousPost;
    delete globalThis.__wasmerHostFileSystem;
    delete globalThis.__wasmerHandleFileSystemRpc;
  }
});
