// Browser worker bootstrap. The Node entrypoint always overrides the worker
// URL with its own `node-worker.js`, so this file stays browser-only.
Error.stackTraceLimit = 50;

let worker;
const pendingMessages = [];

globalThis.onmessage = async ({ data }) => {
  try {
    await handleMessage(data);
  } catch (error) {
    // An unhandled rejection inside a worker never reaches the parent's
    // `onerror`; log it so task failures don't disappear silently.
    console.error("Wasmer SDK worker failed:", error);
    throw error;
  }
};

async function handleMessage(data) {
  if (data.type === "init") {
    const { memory, module, id, sdkUrl } = data;
    const sdk = await import(sdkUrl);
    await sdk.default({ module_or_path: module, memory });
    const initializedWorker = new sdk.ThreadPoolWorker(id);
    // Drain everything queued during init before publishing the worker, so
    // messages are handled in arrival order. Messages that arrive while
    // draining are appended and picked up by the loop; there is no await
    // between the final emptiness check and the assignment.
    while (pendingMessages.length > 0) {
      await initializedWorker.handle(pendingMessages.shift());
    }
    worker = initializedWorker;
    return;
  }

  if (worker) await worker.handle(data);
  else pendingMessages.push(data);
}
