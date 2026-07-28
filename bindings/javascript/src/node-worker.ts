import { parentPort } from "node:worker_threads";
import type { NodeNetworkMethod } from "./node-network.js";

if (!parentPort) throw new Error("Wasmer SDK worker has no parent port");
const port: NonNullable<typeof parentPort> = parentPort;

Error.stackTraceLimit = 50;
installNetworkProxy();

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

port.on("message", async (data) => {
  try {
    await handleMessage(data);
  } catch (error) {
    console.error("Wasmer SDK worker failed:", error);
    throw error;
  }
});

async function handleMessage(data: any): Promise<void> {
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
  ) => callNetwork(bridgeId, "socketRead", [id, maximum], maximum + 16);
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
  minimumPayload = 0,
): unknown {
  const payloadBytes = Math.max(1024 * 1024, minimumPayload);
  const response = new SharedArrayBuffer(16 + payloadBytes);
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
  const payload = new Uint8Array(response, 16, length);
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
