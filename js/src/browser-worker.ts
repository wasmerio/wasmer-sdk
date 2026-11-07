import "./node-compat.js";
import type { NodeNetworkMethod } from "./node-network.js";
import { installHostFileSystemWorkerBridge } from "./host-filesystem.js";
import {
  NETWORK_RPC_CONTROL_BYTES,
  networkResponseBufferBytes,
} from "./node-network-rpc.js";
import {
  installCapiObjectBridge,
  isCapiDispatchHandled,
  receiveCapiDispatch,
  setCapiMessageWorkerId,
} from "./capi-worker-bridge.js";

interface WorkerRuntime {
  handle(message: unknown): Promise<void>;
  collectSharedObjects(): void;
  free(): void;
}

interface InitMessage {
  type: "init";
  id: number;
  sdkUrl: string;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  retireAfterTask?: boolean;
  /** Address of this worker's termination gate in SDK memory. */
  gate?: number;
}

Error.stackTraceLimit = 50;
installNetworkProxy();
installHostFileSystemWorkerBridge();
installCapiObjectBridge((message) => globalThis.postMessage(message));
let runtimeMemory: WebAssembly.Memory | undefined;
globalThis.addEventListener("error", (event) => {
  console.error(
    "[wasmer-sdk-worker-error]",
    runtimeMemory?.buffer.byteLength,
    event.error?.stack ?? event.message,
  );
});
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  reportWorkerFailure(event.reason);
});

let worker: WorkerRuntime | undefined;
let retireAfterTask = false;
const pendingMessages: unknown[] = [];
let failureReported = false;

function reportWorkerFailure(error: unknown): void {
  if (failureReported) return;
  failureReported = true;
  console.error("Wasmer SDK worker failed:", error);
  // Logging a rejected handler leaves the scheduler waiting forever for Idle.
  // An uncaught worker error reaches WorkerHandle.onerror, which fails joins
  // and closes the pool.
  globalThis.reportError(error);
}

globalThis.onmessage = ({ data }: MessageEvent<unknown>) => {
  void handleMessage(data).catch(reportWorkerFailure);
};

async function handleMessage(data: unknown): Promise<void> {
  if ((data as { type?: string } | null)?.type === "wasmer-shutdown") {
    shutdown();
    return;
  }
  data = receiveCapiDispatch(data);
  if (isCapiDispatchHandled(data)) return;
  if (isInitMessage(data)) {
    runtimeMemory = data.memory;
    await initialize(data);
    return;
  }

  if (worker) {
    if ((data as { type?: string })?.type === "wasmer-collect-shared") {
      worker.collectSharedObjects();
    } else {
      // Rust consumes the shared-object envelope when it dispatches the task.
      // Awaiting here keeps that envelope (and every attached guest memory)
      // alive for the whole task, including long-lived background jobs.
      const completion = worker.handle(data);
      return retireAfterTask ? completion.then(retireWorker) : completion;
    }
  }
  else pendingMessages.push(data);
}

function retireWorker(): void {
  // The dedicated worker receives one WASIX thread only. Its completion
  // includes shutdown of worker-local async contexts. Never destroy a pooled
  // worker here: it may still own timers or unrelated asynchronous jobs.
  worker?.collectSharedObjects();
  worker?.free(); // Must be the final call into this SDK instance.
  worker = undefined;
  // The pool frees this thread's TLS and stack once it sees "retired": a
  // thread must not destroy itself (see `worker_gate.rs`).
  globalThis.postMessage({ type: "retired" });
  globalThis.close();
}

/**
 * Exit at the pool's request. This runs from the message loop, so no SDK code
 * is executing on this thread and it cannot hold a runtime lock. Report the
 * exit and close; the pool then frees this thread's TLS and stack.
 */
function shutdown(): void {
  worker = undefined;
  globalThis.postMessage({ type: "exited" });
  globalThis.close();
}

async function initialize(data: InitMessage): Promise<void> {
  setCapiMessageWorkerId(data.id);
  const sdk = (await import(/* @vite-ignore */ data.sdkUrl)) as {
    default(options: {
      module_or_path: WebAssembly.Module;
      memory: WebAssembly.Memory;
    }): Promise<{
      __tls_base?: WebAssembly.Global;
      __stack_alloc?: WebAssembly.Global;
    }>;
    ThreadPoolWorker: new (
      id: number,
      gate?: number,
      tlsBase?: number,
      stackAlloc?: number,
    ) => WorkerRuntime;
  };
  const exports = await sdk.default({ module_or_path: data.module, memory: data.memory });
  retireAfterTask = data.retireAfterTask === true;
  const initialized = new sdk.ThreadPoolWorker(
    data.id,
    data.gate,
    exports?.__tls_base?.value,
    exports?.__stack_alloc?.value,
  );
  worker = initialized;
  while (pendingMessages.length > 0) {
    void handleMessage(pendingMessages.shift()).catch(reportWorkerFailure);
  }
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
