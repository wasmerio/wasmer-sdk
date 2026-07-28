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
    worker = initializedWorker;
    for (const pending of pendingMessages.splice(0)) {
      await initializedWorker.handle(pending);
    }
    return;
  }

  if (worker) await worker.handle(data);
  else pendingMessages.push(data);
}

function installNetworkProxy(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerNodeResolve = (host: string) =>
    Promise.resolve(callNetwork("resolve", [host]));
  scope.__wasmerNodeConnectTcp = (local: string, peer: string) =>
    Promise.resolve(callNetwork("connectTcp", [local, peer]));
  scope.__wasmerNodeListenTcp = (address: string) =>
    callNetwork("listenTcp", [address]);
  scope.__wasmerNodeListenerAccept = (id: number) =>
    callNetwork("listenerAccept", [id]);
  scope.__wasmerNodeListenerClose = (id: number) =>
    callNetwork("listenerClose", [id]);
  scope.__wasmerNodeSocketRead = (id: number, maximum: number) =>
    callNetwork("socketRead", [id, maximum], maximum + 16);
  scope.__wasmerNodeSocketWrite = (id: number, bytes: Uint8Array) =>
    callNetwork("socketWrite", [id, bytes]);
  scope.__wasmerNodeSocketFlush = (id: number) =>
    callNetwork("socketFlush", [id]);
  scope.__wasmerNodeSocketClose = (id: number) =>
    callNetwork("socketClose", [id]);
  scope.__wasmerNodeSocketReadable = (id: number) =>
    callNetwork("socketReadable", [id]);
  scope.__wasmerNodeSocketWritable = (id: number) =>
    callNetwork("socketWritable", [id]);
  scope.__wasmerNodeSocketSetNoDelay = (id: number, enabled: boolean) =>
    callNetwork("socketSetNoDelay", [id, enabled]);
  scope.__wasmerNodeSocketSetKeepAlive = (id: number, enabled: boolean) =>
    callNetwork("socketSetKeepAlive", [id, enabled]);
}

function callNetwork(
  method: NodeNetworkMethod,
  args: unknown[],
  minimumPayload = 0,
): unknown {
  const payloadBytes = Math.max(1024 * 1024, minimumPayload);
  const response = new SharedArrayBuffer(16 + payloadBytes);
  const control = new Int32Array(response, 0, 4);
  port.postMessage({
    type: "wasmer-network-rpc",
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
