import { parentPort } from "node:worker_threads";

// Plays the SDK in a pool worker: cache calls carry views of shared memory,
// which the main thread must read and write in place.
const memory = new Uint8Array(new SharedArrayBuffer(64));
const pending = new Map();
let nextRequest = 1;
let cacheId;
const started = new Promise((resolve) => {
  parentPort.on("message", (message) => {
    if (message?.type === "cache-id") {
      cacheId = message.cacheId;
      resolve();
    }
  });
});
parentPort.on("message", (message) => {
  if (message?.type !== "wasmer-cache-rpc-response") return;
  const request = pending.get(message.requestId);
  pending.delete(message.requestId);
  if (message.ok) request.resolve(message.value);
  else request.reject(new Error(message.error));
});

function call(method, args) {
  const requestId = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    parentPort.postMessage({
      type: "wasmer-cache-rpc",
      cacheId,
      requestId,
      method,
      args,
    });
  });
}

await started;
const path = "cache-v1/packages/worker.bin";
memory.set(new TextEncoder().encode("from worker"), 4);
await call("put", [path, memory.subarray(4, 15)]);
const opened = await call("open", [path]);
const read = await call("readInto", [
  opened.handle,
  memory.subarray(32, 32 + opened.size),
]);
parentPort.postMessage({
  type: "result",
  size: opened.size,
  read,
  text: new TextDecoder().decode(memory.slice(32, 32 + read)),
});
