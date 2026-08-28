import { parentPort } from "node:worker_threads";
import type { NodeNetworkMethod } from "./node-network.js";
import {
  NETWORK_RPC_CONTROL_BYTES,
  networkResponseBufferBytes,
} from "./node-network-rpc.js";
import type { NodeCacheMethod } from "./node-cache.js";
import {
  installCapiObjectBridge,
  isCapiDispatchHandled,
  receiveCapiDispatch,
  setCapiMessageWorkerId,
} from "./capi-worker-bridge.js";

if (!parentPort) throw new Error("Wasmer SDK worker has no parent port");
const port: NonNullable<typeof parentPort> = parentPort;

Error.stackTraceLimit = 50;
installNetworkProxy();
installCacheProxy();
installCapiObjectBridge((message, transfer = []) => port.postMessage(message, transfer));

Object.defineProperty(globalThis, "postMessage", {
  configurable: true,
  value: (message: unknown) => port.postMessage(message),
});

let worker:
  | {
      handle(message: unknown): Promise<void>;
    }
  | undefined;
const pendingMessages: unknown[] = [];
let nextCacheRequestId = 1;
const pendingCacheRequests = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }
>();

port.on("message", async (data) => {
  try {
    await handleMessage(data);
  } catch (error) {
    console.error("Wasmer SDK worker failed:", error);
    throw error;
  }
});

async function handleMessage(data: any): Promise<void> {
  data = receiveCapiDispatch(data);
  if (isCapiDispatchHandled(data)) return;
  if (data?.type === "wasmer-cache-rpc-response") {
    const pending = pendingCacheRequests.get(data.requestId);
    if (!pending) return;
    pendingCacheRequests.delete(data.requestId);
    if (data.ok) pending.resolve(data.value);
    else pending.reject(new Error(data.error));
    return;
  }

  if (data?.type === "init") {
    setCapiMessageWorkerId(data.id);
    const sdk = await import(data.sdkUrl);
    await sdk.default({
      module_or_path: data.module,
      memory: data.memory,
    });
    const initializedWorker = new sdk.ThreadPoolWorker(data.id);
    while (pendingMessages.length > 0) {
      await initializedWorker.handle(pendingMessages.shift());
    }
    worker = initializedWorker;
    return;
  }

  if (worker) await worker.handle(data);
  else pendingMessages.push(data);
}

function installCacheProxy(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerNodeCacheGet = (cacheId: number, path: string) =>
    callCache(cacheId, "get", [path]);
  scope.__wasmerNodeCachePut = (
    cacheId: number,
    path: string,
    bytes: Uint8Array,
  ) => callCache(cacheId, "put", [path, bytes.slice()]);
  scope.__wasmerNodeCacheRemove = (cacheId: number, path: string) =>
    callCache(cacheId, "remove", [path]);
}

function callCache(
  cacheId: number,
  method: NodeCacheMethod,
  args: unknown[],
): Promise<unknown> {
  const requestId = nextCacheRequestId++;
  return new Promise((resolve, reject) => {
    pendingCacheRequests.set(requestId, { resolve, reject });
    port.postMessage({
      type: "wasmer-cache-rpc",
      cacheId,
      requestId,
      method,
      args,
    });
  });
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
  scope.__wasmerHostListenTcp = (bridgeId: number, address: string) =>
    callNetwork(bridgeId, "listenTcp", [address]);
  scope.__wasmerHostListenerAccept = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerAccept", [id]);
  scope.__wasmerHostListenerRefresh = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerRefresh", [id]);
  scope.__wasmerHostListenerReadable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerReadable", [id]);
  scope.__wasmerHostListenerClose = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerClose", [id]);
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
  const response = new SharedArrayBuffer(
    networkResponseBufferBytes(method, args),
  );
  const control = new Int32Array(response, 0, 4);
  port.postMessage({
    type: "wasmer-network-rpc",
    bridgeId,
    method,
    args,
    response,
  });

  const status = Atomics.wait(control, 0, 0);
  if (status !== "ok" && status !== "not-equal") {
    throw new Error(`Node network bridge wait failed: ${status}`);
  }

  const kind = control[1];
  const length = control[2];
  const payload = new Uint8Array(
    response,
    NETWORK_RPC_CONTROL_BYTES,
    length,
  );
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
      throw new Error(`invalid Node network bridge response kind ${kind}`);
  }
}

function decodeShared(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.slice());
}
