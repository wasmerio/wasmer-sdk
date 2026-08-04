import type { NodeNetworkMethod } from "./node-network.js";
import {
  NETWORK_RPC_CONTROL_BYTES,
  networkResponseBufferBytes,
} from "./node-network-rpc.js";

interface WorkerRuntime {
  handle(message: unknown): Promise<void>;
}

interface InitMessage {
  type: "init";
  id: number;
  sdkUrl: string;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
}

Error.stackTraceLimit = 50;
installNetworkProxy();
let runtimeMemory: WebAssembly.Memory | undefined;
globalThis.addEventListener("error", (event) => {
  console.error(
    "[wasmer-sdk-worker-error]",
    runtimeMemory?.buffer.byteLength,
    event.error?.stack ?? event.message,
  );
});
globalThis.addEventListener("unhandledrejection", (event) => {
  console.error("[wasmer-sdk-worker-rejection]", event.reason?.stack ?? event.reason);
});

let worker: WorkerRuntime | undefined;
const pendingMessages: unknown[] = [];

globalThis.onmessage = ({ data }: MessageEvent<unknown>) => {
  void handleMessage(data).catch((error: unknown) => {
    console.error("Wasmer SDK worker failed:", error);
    throw error;
  });
};

async function handleMessage(data: unknown): Promise<void> {
  if (isInitMessage(data)) {
    runtimeMemory = data.memory;
    const sdk = (await import(data.sdkUrl)) as {
      default(options: {
        module_or_path: WebAssembly.Module;
        memory: WebAssembly.Memory;
      }): Promise<unknown>;
      ThreadPoolWorker: new (id: number) => WorkerRuntime;
    };
    await sdk.default({ module_or_path: data.module, memory: data.memory });
    const initialized = new sdk.ThreadPoolWorker(data.id);
    while (pendingMessages.length > 0) {
      await initialized.handle(pendingMessages.shift());
    }
    worker = initialized;
    return;
  }

  if (worker) await worker.handle(data);
  else pendingMessages.push(data);
}

function installNetworkProxy(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerHostResolveSync = (bridgeId: number, host: string) =>
    callNetwork(bridgeId, "resolve", [host]);
  scope.__wasmerHostConnectTcpSync = (
    bridgeId: number,
    local: string,
    peer: string,
  ) => callNetwork(bridgeId, "connectTcp", [local, peer]);
  scope.__wasmerHostSocketRead = (
    bridgeId: number,
    id: number,
    maximum: number,
  ) => callNetwork(bridgeId, "socketRead", [id, maximum]);
  scope.__wasmerHostSocketWrite = (
    bridgeId: number,
    id: number,
    bytes: Uint8Array,
  ) => callNetwork(bridgeId, "socketWrite", [id, bytes]);
  scope.__wasmerHostSocketFlush = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketFlush", [id]);
  scope.__wasmerHostSocketClose = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketClose", [id]);
  scope.__wasmerHostSocketReadable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketReadable", [id]);
  scope.__wasmerHostSocketWritable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketWritable", [id]);
  scope.__wasmerHostSocketSetNoDelay = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => callNetwork(bridgeId, "socketSetNoDelay", [id, enabled]);
  scope.__wasmerHostSocketSetKeepAlive = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => callNetwork(bridgeId, "socketSetKeepAlive", [id, enabled]);
  scope.__wasmerHostSocketRefresh = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketRefresh", [id]);
}

function callNetwork(
  bridgeId: number,
  method: NodeNetworkMethod,
  args: unknown[],
): unknown {
  const response = new SharedArrayBuffer(networkResponseBufferBytes(method, args));
  const control = new Int32Array(response, 0, 4);
  globalThis.postMessage({
    type: "wasmer-network-rpc",
    bridgeId,
    method,
    args,
    response,
  });

  const status = Atomics.wait(control, 0, 0);
  if (status !== "ok" && status !== "not-equal") {
    throw new Error(`WISP network bridge wait failed: ${status}`);
  }

  const kind = control[1];
  const length = control[2];
  const payload = new Uint8Array(response, NETWORK_RPC_CONTROL_BYTES, length);
  switch (kind) {
    case 1:
      return JSON.parse(decodeShared(payload));
    case 2:
      return payload.slice();
    case 3:
      return undefined;
    case 4:
      return null;
    case 5:
      throw new Error(decodeShared(payload));
    default:
      throw new Error(`invalid WISP network bridge response kind ${kind}`);
  }
}

function decodeShared(bytes: Uint8Array): string {
  // Browser TextDecoder rejects views backed by SharedArrayBuffer. Copy the
  // small RPC control payload into an ordinary ArrayBuffer before decoding.
  return new TextDecoder().decode(bytes.slice());
}

function isInitMessage(value: unknown): value is InitMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "init"
  );
}
