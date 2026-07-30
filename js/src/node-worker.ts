import { parentPort } from "node:worker_threads";
import type { NodeNetworkMethod } from "./node-network.js";
import {
  NETWORK_RPC_CONTROL_BYTES,
  networkResponseBufferBytes,
} from "./node-network-rpc.js";
import type { NodeCacheMethod } from "./node-cache.js";

if (!parentPort) throw new Error("Wasmer SDK worker has no parent port");
const port: NonNullable<typeof parentPort> = parentPort;

Error.stackTraceLimit = 50;
installNetworkProxy();
installCacheProxy();

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
  if (data?.type === "wasmer-cache-rpc-response") {
    const pending = pendingCacheRequests.get(data.requestId);
    if (!pending) return;
    pendingCacheRequests.delete(data.requestId);
    if (data.ok) pending.resolve(data.value);
    else pending.reject(new Error(data.error));
    return;
  }

  if (data?.type === "init") {
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
  scope.__wasmerNodeResolve = (bridgeId: number, host: string) =>
    Promise.resolve(callNetwork(bridgeId, "resolve", [host]));
  scope.__wasmerNodeConnectTcp = (
    bridgeId: number,
    local: string,
    peer: string,
  ) => Promise.resolve(callNetwork(bridgeId, "connectTcp", [local, peer]));
  scope.__wasmerNodeListenTcp = (bridgeId: number, address: string) =>
    callNetwork(bridgeId, "listenTcp", [address]);
  scope.__wasmerNodeListenerAccept = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerAccept", [id]);
  scope.__wasmerNodeListenerRefresh = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerRefresh", [id]);
  scope.__wasmerNodeListenerReadable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerReadable", [id]);
  scope.__wasmerNodeListenerClose = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "listenerClose", [id]);
  scope.__wasmerNodeSocketRead = (
    bridgeId: number,
    id: number,
    maximum: number,
  ) => callNetwork(bridgeId, "socketRead", [id, maximum]);
  scope.__wasmerNodeSocketWrite = (
    bridgeId: number,
    id: number,
    bytes: Uint8Array,
  ) => callNetwork(bridgeId, "socketWrite", [id, bytes]);
  scope.__wasmerNodeSocketFlush = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketFlush", [id]);
  scope.__wasmerNodeSocketClose = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketClose", [id]);
  scope.__wasmerNodeSocketReadable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketReadable", [id]);
  scope.__wasmerNodeSocketWritable = (bridgeId: number, id: number) =>
    callNetwork(bridgeId, "socketWritable", [id]);
  scope.__wasmerNodeSocketSetNoDelay = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => callNetwork(bridgeId, "socketSetNoDelay", [id, enabled]);
  scope.__wasmerNodeSocketSetKeepAlive = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => callNetwork(bridgeId, "socketSetKeepAlive", [id, enabled]);
  scope.__wasmerNodeSocketRefresh = (bridgeId: number, id: number) =>
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
      return JSON.parse(new TextDecoder().decode(payload));
    case 2:
      return payload.slice();
    case 3:
      return undefined;
    case 4:
      return null;
    case 5:
      throw new Error(new TextDecoder().decode(payload));
    default:
      throw new Error(`invalid Node network bridge response kind ${kind}`);
  }
}
