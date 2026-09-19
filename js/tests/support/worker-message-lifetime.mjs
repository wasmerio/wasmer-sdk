import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

// Run the real browser dispatcher in an isolated process, with a mock Rust
// entrypoint that consumes its message but keeps the dispatched task pending.
const tasks = [];
const memories = [];
const failures = [];
globalThis.addEventListener = () => {};
globalThis.postMessage = () => {};
globalThis.reportError = error => failures.push(error);
globalThis.beginTask = message => {
  memories.push(new WeakRef(message[2][0][1]));
  return new Promise((resolve, reject) => tasks.push({ resolve, reject }));
};
await import("../../dist/browser-worker.js");

function dispatch(id) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
  globalThis.onmessage({ data: [
    "wasmer-shared-objects-v1-test", { type: "async" }, [[id, memory]],
  ] });
}

// Exercise both messages queued during initialization and normal dispatch.
for (let id = 0; id < 8; id++) dispatch(id);
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
  export default async function () {}
  export class ThreadPoolWorker {
    handle(message) { return globalThis.beginTask(message); }
    collectSharedObjects() {}
  }
`);
globalThis.onmessage({ data: { type: "init", id: 1, sdkUrl } });
for (let turn = 0; turn < 20 && tasks.length < 8; turn++) await setImmediate();
assert.equal(tasks.length, 8);
for (let id = 8; id < 16; id++) dispatch(id);

// Do not dereference between collections: WeakRef.deref itself keeps an object
// alive for the rest of the current job. Task resolvers deliberately stay live.
for (let turn = 0; turn < 12; turn++) {
  await setImmediate();
  globalThis.gc();
}
assert.equal(memories.length, 16);
assert.equal(tasks.length, 16);
assert.equal(memories.filter(ref => ref.deref()).length, 0,
  "a pending task retained guest memories from its transport envelope");

const failure = new Error("late task failure");
tasks[0].reject(failure);
for (const task of tasks.slice(1)) task.resolve();
await setImmediate();
assert.deepEqual(failures, [failure]);
