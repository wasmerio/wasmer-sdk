import { isHostFileSystemRequest, respondToHostFileSystem } from "./sdk/dist/host-filesystem.js";

const native = window.webkit.messageHandlers.wasmer;
let worker;
let nextID = 0;
const pending = new Map();
let mode = "idle";

function startWorker() {
  const session = crypto.randomUUID();
  const networkReady = native.postMessage({ kind: "network", session, method: "open", args: [] });
  void networkReady.catch(() => {});
  const closeNetwork = () => { void native.postMessage({ kind: "network", session, method: "close", args: [] }).catch(() => {}); };
  const instance = new Worker(new URL("./runtime.js", import.meta.url), { type: "module" });
  instance.closeNetwork = closeNetwork;
  instance.onmessage = async ({ data }) => {
    if (data.kind === "network") {
      try {
        await networkReady;
        const result = await native.postMessage({ kind: "network", session, method: data.method, args: data.args });
        instance.postMessage({ kind: "networkResult", id: data.id, value: result.value,
          error: result.error ? `${result.error.code}: ${result.error.message}` : undefined });
      } catch (error) { instance.postMessage({ kind: "networkResult", id: data.id, error: String(error) }); }
      return;
    }
    if (isHostFileSystemRequest(data)) {
      try {
        const result = await native.postMessage({ kind: "filesystem", mount: data.mount, method: data.method, args: data.args });
        respondToHostFileSystem(data, result);
      } catch (error) {
        respondToHostFileSystem(data, { error: { code: "EIO", message: String(error) } });
      }
      return;
    }
    if (data.kind === "progress" || data.kind === "diagnostic") {
      void native.postMessage({ kind: "progress", message: data.message });
      return;
    }
    if (data.kind === "ready") {
      void native.postMessage({ ...data, pageIsolated: crossOriginIsolated });
      return;
    }
    if (data.kind === "listeningPorts") {
      void native.postMessage(data);
      return;
    }
    if (data.kind === "terminalOutput") {
      let error;
      try {
        const base64 = btoa(String.fromCharCode(...data.bytes));
        await native.postMessage({ kind: "terminalOutput", stream: data.stream, base64 });
      } catch (cause) { error = String(cause); }
      instance.postMessage({ method: "terminalOutputAck", sequence: data.sequence, error });
      return;
    }
    if (data.kind === "terminalExit") {
      closeNetwork();
      void native.postMessage(data);
      instance.terminate();
      if (worker === instance) worker = undefined;
      mode = "idle";
      for (const completion of pending.values()) completion.reject(new Error("Terminal exited"));
      pending.clear();
      return;
    }
    const completion = pending.get(data.id);
    if (!completion) return;
    pending.delete(data.id);
    // Give each command its own worker so WebKit can release its Wasm state
    // after completion. The invisible control page persists across commands.
    if (!data.keepAlive) {
      closeNetwork();
      instance.terminate();
      if (worker === instance) worker = undefined;
      mode = "idle";
    } else if (completion.method === "startTerminal") mode = "terminal";
    if (data.error) completion.reject(new Error(data.error));
    else completion.resolve(data.result);
  };
  instance.onerror = (event) => {
    closeNetwork();
    for (const completion of pending.values()) completion.reject(new Error(event.message));
    pending.clear();
    mode = "idle";
    void native.postMessage({ kind: "fatal", message: event.message });
    instance.terminate();
    if (worker === instance) worker = undefined;
  };
  return instance;
}
worker = startWorker();

globalThis.wasmerPrototype = {
  request(command) {
    return new Promise((resolve, reject) => {
      const control = ["writeTerminal", "resizeTerminal", "stopTerminal", "httpRequest"].includes(command.method);
      if (control ? mode !== "terminal" : mode !== "idle") {
        reject(new Error("The runtime is busy or no terminal is running")); return;
      }
      if (!control) mode = "command";
      const id = ++nextID;
      pending.set(id, { resolve, reject, method: command.method });
      worker ??= startWorker();
      worker.postMessage({ id, ...command });
    });
  },
  stop() {
    worker?.closeNetwork();
    worker?.terminate();
    worker = undefined;
    for (const completion of pending.values()) completion.reject(new Error("Runtime closed"));
    pending.clear();
    mode = "idle";
  },
};
