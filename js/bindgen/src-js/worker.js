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
  if (data.type === "wasmer-shutdown") {
    // Runs from the message loop, so no SDK code is executing on this thread.
    // Report the exit and close; the pool then frees this thread's TLS and
    // stack (a thread must not destroy itself).
    worker = undefined;
    globalThis.postMessage({ type: "exited" });
    globalThis.close();
    return;
  }
  if (data.type === "init") {
    const { memory, module, id, sdkUrl, gate } = data;
    const sdk = await import(sdkUrl);
    const exports = await sdk.default({ module_or_path: module, memory });
    const initializedWorker = new sdk.ThreadPoolWorker(
      id,
      gate,
      exports?.__tls_base?.value,
      exports?.__stack_alloc?.value,
    );
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
