Error.stackTraceLimit = 50;

let send;
let installReceiver;

if (
  typeof process !== "undefined" &&
  process.versions?.node &&
  typeof globalThis.postMessage !== "function"
) {
  const { parentPort } = await import("node:worker_threads");
  if (!parentPort) throw new Error("Wasmer SDK worker has no parent port");
  send = (message) => parentPort.postMessage(message);
  installReceiver = (handler) =>
    parentPort.on("message", (data) => handler({ data }));
  globalThis.postMessage = send;
} else {
  send = (message) => globalThis.postMessage(message);
  installReceiver = (handler) => {
    globalThis.onmessage = handler;
  };
}

let worker;
const pendingMessages = [];

installReceiver(async ({ data }) => {
  if (data.type === "init") {
    const { memory, module, id, sdkUrl } = data;
    const sdk = await import(sdkUrl);
    await sdk.default({ module_or_path: module, memory });
    worker = new sdk.ThreadPoolWorker(id);
    for (const pending of pendingMessages.splice(0)) {
      await worker.handle(pending);
    }
    return;
  }

  if (worker) await worker.handle(data);
  else pendingMessages.push(data);
});
