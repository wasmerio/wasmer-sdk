import { isHostFileSystemRequest, respondToHostFileSystem } from "./sdk/dist/host-filesystem.js";
import { callNativeFileSystem } from "./native-filesystem.js";

const native = window.webkit.messageHandlers.wasmer;
const session = crypto.randomUUID();
const networkReady = native.postMessage({ kind: "network", session, method: "open", args: [] });
void networkReady.catch(() => {});
const worker = new Worker(new URL("./runtime.js", import.meta.url), { type: "module" });
const pending = new Map();
let stopped = false;
async function stop(message = "Runtime closed") {
  if (stopped) return;
  stopped = true;
  void native.postMessage({ kind: "network", session, method: "close", args: [] }).catch(() => {});
  for (const entry of pending.values()) entry.resolve({ error: { code: "CLIENT_CLOSED", message } });
  pending.clear();
  // Give the storage worker a bounded opportunity to flush and release its
  // volume lock. A wedged guest must never prevent Restart from completing.
  const id = crypto.randomUUID();
  let timer;
  await Promise.race([
    new Promise(resolve => { pending.set(id, {resolve}); worker.postMessage({kind:"storage-close", id}); }),
    new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
  ]);
  clearTimeout(timer); pending.delete(id); worker.terminate();
}
worker.onmessage = async ({ data }) => {
  if (data.kind === "network") {
    try {
      await networkReady;
      const result = await native.postMessage({ kind: "network", session, method: data.method, args: data.args });
      worker.postMessage({ kind: "networkResult", id: data.id, value: result.value,
        error: result.error ? `${result.error.code}: ${result.error.message}` : undefined });
    } catch (error) { worker.postMessage({ kind: "networkResult", id: data.id, error: String(error) }); }
    return;
  }
  if (isHostFileSystemRequest(data)) {
    try { respondToHostFileSystem(data, await callNativeFileSystem(data, message => native.postMessage(message))); }
    catch (error) { respondToHostFileSystem(data, { error: { code: "EIO", message: String(error) } }); }
    return;
  }
  if (data.kind === "ready") { void native.postMessage({ ...data, pageIsolated: crossOriginIsolated }); return; }
  if (data.kind === "diagnostic" || data.kind === "progress") { void native.postMessage({ kind: "progress", message: data.message }); return; }
  if (data.kind === "packageProgress") {
    const entry = pending.get(data.id);
    if (entry && !entry.cancelled) {
      entry.progress = (entry.progress ?? Promise.resolve()).then(() => {
        if (!entry.cancelled) return native.postMessage(data);
      }).catch(() => {});
    }
    return;
  }
  const entry = pending.get(data.id);
  if (entry) {
    if (entry.cancelled && !data.error) {
      // Cancellation can overtake a result already queued by the worker.
      const cleanup = entry.method === "command.spawn" ? ["process.release", { process: data.value.handle }] :
        entry.method === "sandbox.create" ? ["sandbox.close", { sandbox: data.value }] :
        entry.method === "tcp.connect" ? ["tcp.close", { connection: data.value }] : undefined;
      if (cleanup) worker.postMessage({ id: crypto.randomUUID(), method: cleanup[0], args: cleanup[1] });
    } else {
      // Flush the final progress message before settling the Swift await.
      await entry.progress;
      if (!entry.cancelled) entry.resolve(data);
    }
    pending.delete(data.id);
  }
};
worker.onerror = event => {
  stop(event.message);
  void native.postMessage({ kind: "fatal", message: event.message });
};
globalThis.wasmerRPC = {
  request(command) {
    if (stopped) return Promise.resolve({ error: { code: "CLIENT_CLOSED", message: "Runtime closed" } });
    return new Promise(resolve => { pending.set(command.id, { resolve, method: command.method, cancelled: false }); worker.postMessage(command); });
  },
  cancel(id) {
    const entry = pending.get(id);
    if (entry) {
      entry.cancelled = true;
      entry.resolve({ error: { code: "CANCELLED", message: "Swift task cancelled" } });
    }
    worker.postMessage({ kind: "cancel", id });
  },
  stop,
};
