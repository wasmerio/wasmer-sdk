import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import test from "node:test";
import { isHostFileSystemRequest, respondToHostFileSystem } from "../dist/host-filesystem.js";

test("binary replies preserve byte ranges, EOF, and earlier replies across buffer reuse", { timeout: 10_000 }, async () => {
  const moduleURL = new URL("../dist/host-filesystem.js", import.meta.url).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import { installHostFileSystemWorkerBridge } from ${JSON.stringify(moduleURL)};
    globalThis.postMessage = value => parentPort.postMessage(value);
    installHostFileSystemWorkerBridge();
    const first = globalThis.__wasmerHostFileSystem(1, 'read', [7, 0, 65536]);
    const eof = globalThis.__wasmerHostFileSystem(1, 'read', [7, 65536, 1]);
    let oversized;
    try { globalThis.__wasmerHostFileSystem(1, 'oversized', []); }
    catch (error) { oversized = error.code; }
    parentPort.postMessage({ done: true, first, eof, oversized });
  `)}`));
  try {
    const data = Uint8Array.from({ length: 65538 }, (_, index) => index % 256);
    const result = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => {
        if (!isHostFileSystemRequest(message)) { resolve(message); return; }
        assert.equal(message.binary, true);
        const value = message.method === "oversized" ? new Uint8Array(600000) :
          message.args[1] === 0 ? data.subarray(1, 65537) : new Uint8Array();
        respondToHostFileSystem(message, { value });
      });
    });
    assert.deepEqual(result.first, data.subarray(1, 65537));
    assert.deepEqual(result.eof, new Uint8Array());
    assert.equal(result.oversized, "EIO");
  } finally {
    await worker.terminate();
  }
});

test("binary host replies retain JSON compatibility for older workers", () => {
  const request = { response: new SharedArrayBuffer(128) };
  respondToHostFileSystem(request, { value: new Uint8Array([0, 128, 255]) });
  const control = new Int32Array(request.response, 0, 2);
  assert.equal(control[0], 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(request.response, 8, control[1]))), { value: [0, 128, 255] });
});

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

test('embedder routing serves local worker storage and forwards native mounts', async () => {
  const { installHostFileSystemWorkerBridge, respondToHostFileSystem, HOST_FS_MESSAGE } = await import('../dist/host-filesystem.js');
  const original = { postMessage:globalThis.postMessage, call:globalThis.__wasmerHostFileSystem, forward:globalThis.__wasmerHandleFileSystemRpc };
  const forwarded = [];
  try {
    globalThis.postMessage = request => { forwarded.push(request.mount); respondToHostFileSystem(request,{value:'native'}); };
    installHostFileSystemWorkerBridge(request => {
      if (request.mount !== 0x80000001) return false;
      respondToHostFileSystem(request,{value:'opfs'}); return true;
    });
    assert.equal(globalThis.__wasmerHostFileSystem(0x80000001,'stat',['file']), 'opfs');
    assert.equal(globalThis.__wasmerHostFileSystem(1,'stat',['file']), 'native');
    const response = new SharedArrayBuffer(256);
    assert.equal(globalThis.__wasmerHandleFileSystemRpc({type:HOST_FS_MESSAGE,mount:0x80000001,method:'stat',args:['file'],response}),true);
    assert.equal(Atomics.load(new Int32Array(response),0),1);
    assert.deepEqual(forwarded,[1]);
  } finally {
    globalThis.postMessage = original.postMessage;
    globalThis.__wasmerHostFileSystem = original.call;
    globalThis.__wasmerHandleFileSystemRpc = original.forward;
  }
});
