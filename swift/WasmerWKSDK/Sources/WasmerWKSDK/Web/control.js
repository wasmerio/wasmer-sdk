import { isHostFileSystemRequest, respondToHostFileSystem } from "./sdk/dist/host-filesystem.js";

const native = window.webkit.messageHandlers.wasmer;
const session = crypto.randomUUID();
const networkReady = native.postMessage({ kind: "network", session, method: "open", args: [] });
void networkReady.catch(() => {});
const worker = new Worker(new URL("./runtime.js", import.meta.url), { type: "module" });
const pending = new Map();
let stopped = false;
function stop(message = "Runtime closed") {
  if (stopped) return;
  stopped = true;
  void native.postMessage({ kind: "network", session, method: "close", args: [] }).catch(() => {});
  worker.terminate();
  for (const resolve of pending.values()) resolve({ error: { code: "CLIENT_CLOSED", message } });
  pending.clear();
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
    try { respondToHostFileSystem(data, await native.postMessage({ kind: "filesystem", mount: data.mount, method: data.method, args: data.args })); }
    catch (error) { respondToHostFileSystem(data, { error: { code: "EIO", message: String(error) } }); }
    return;
  }
  if (data.kind === "ready") { void native.postMessage({ ...data, pageIsolated: crossOriginIsolated }); return; }
  if (data.kind === "diagnostic" || data.kind === "progress") { void native.postMessage({ kind: "progress", message: data.message }); return; }
  const resolve = pending.get(data.id);
  if (resolve) { pending.delete(data.id); resolve(data); }
};
worker.onerror = event => {
  stop(event.message);
  void native.postMessage({ kind: "fatal", message: event.message });
};
globalThis.wasmerRPC = {
  request(command) {
    if (stopped) return Promise.resolve({ error: { code: "CLIENT_CLOSED", message: "Runtime closed" } });
    return new Promise(resolve => { pending.set(command.id, resolve); worker.postMessage(command); });
  },
  cancel(id) {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.({ error: { code: "CANCELLED", message: "Swift task cancelled" } });
    worker.postMessage({ kind: "cancel", id });
  },
  stop,
};
