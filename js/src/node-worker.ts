import "./node-compat.js";
import { parentPort, threadId, workerData } from "node:worker_threads";
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
import { GuestMemoryBudget } from "./guest-memory-budget.js";
import { installGuestMemoryCounters } from "./guest-memory-diagnostics.js";
import { obtainGarbageCollector } from "./node-garbage-collector.js";

if (!parentPort) throw new Error("Wasmer SDK worker has no parent port");
const port: NonNullable<typeof parentPort> = parentPort;

// Test diagnostics, enabled by `globalThis.__wasmerGuestMemoryDiagnostics`
// on the main thread (see `nodeWorkerGuestMemoryStats`). "no-collector"
// also simulates a host without a garbage-collection hook.
const diagnostics = (
  workerData as { wasmerGuestMemoryDiagnostics?: unknown } | undefined
)?.wasmerGuestMemoryDiagnostics;
const guestMemoryCounters = diagnostics
  ? installGuestMemoryCounters()
  : undefined;

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
      collectSharedObjects(): void;
      takeReleasedGuestMemory(): number;
      free(): void;
    }
  | undefined;
let retireAfterTask = false;
let guestMemory: GuestMemoryBudget | undefined;
/** Messages the SDK runtime is still handling: tasks, timers and jobs. */
let activeJobs = 0;
/** The pool retired this pooled worker: stop once its jobs are done. */
let retiring = false;
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
  if (data?.type === "wasmer-shutdown") shutdown();
  if (data?.type === "wasmer-guest-memory-stats") {
    port.postMessage({
      type: "wasmer-guest-memory-stats-reply",
      requestId: data.requestId,
      stats: {
        threadId,
        ...guestMemoryCounters?.(),
        released: guestMemory?.released ?? 0,
        ...guestMemory?.stats,
      },
    });
    return;
  }
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
    const exports = await sdk.default({
      module_or_path: data.module,
      memory: data.memory,
    });
    retireAfterTask = data.retireAfterTask === true;
    guestMemory = new GuestMemoryBudget({
      budget: Number(data.guestMemoryGcBudget) || 0,
      obtainCollector:
        diagnostics === "no-collector" ? () => null : obtainGarbageCollector,
      requestRetirement: () => port.postMessage({ type: "retire-request" }),
    });
    // The pool frees this thread's TLS and stack after it exits.
    const initializedWorker = new sdk.ThreadPoolWorker(
      data.id,
      data.gate,
      exports?.__tls_base?.value,
      exports?.__stack_alloc?.value,
    );
    worker = initializedWorker;
    while (pendingMessages.length > 0) {
      await handleMessage(pendingMessages.shift());
    }
    return;
  }

  if (worker) {
    if (data?.type === "wasmer-collect-shared") {
      worker.collectSharedObjects();
      // The pool has dropped the finished processes: their memories are
      // dead unless this isolate collects them.
      guestMemory?.release(worker.takeReleasedGuestMemory());
    } else if (data?.type === "wasmer-retire") {
      retiring = true;
      if (activeJobs === 0) retireWorker();
    } else {
      const blocking = isBlockingTask(data);
      if (blocking) guestMemory?.blockingTaskStarted();
      activeJobs += 1;
      try {
        // Rust consumes the shared-object envelope when it dispatches the
        // task. Do not keep it in this suspended frame: it snapshots every
        // shared memory this worker knew, including finished guests', and
        // an asynchronous job can run for a long time.
        const completion = worker.handle(data);
        data = undefined;
        await completion;
      } finally {
        activeJobs -= 1;
        if (blocking) guestMemory?.blockingTaskFinished();
      }
      if (retireAfterTask || (retiring && activeJobs === 0)) retireWorker();
    }
  }
  else pendingMessages.push(data);
}

function isBlockingTask(data: unknown): boolean {
  // Tasks carrying shared objects arrive in a [namespace, payload, objects]
  // envelope.
  const payload = Array.isArray(data) ? data[1] : data;
  const type = (payload as { type?: unknown } | null)?.type;
  return type === "spawn-wasm" || type === "spawn-blocking";
}

/**
 * Stop this worker: a dedicated worker after its single WASIX thread has
 * completed, or a pooled worker the pool retired once its jobs are done.
 *
 * Exiting disposes this thread's isolate, which frees every guest
 * `WebAssembly.Memory` it created, without waiting for a GC. The adapter
 * reports "retired" only once the thread has exited, and the pool then frees
 * this thread's TLS and stack: a thread must not destroy itself (see
 * `worker_gate.rs`). Never retire a pooled worker otherwise: it may still
 * own timers or unrelated asynchronous jobs.
 */
function retireWorker(): never {
  worker?.collectSharedObjects();
  worker?.free(); // Must be the final call into this SDK instance.
  worker = undefined;
  port.postMessage({ type: "retired" });
  process.exit(0);
}

/**
 * Exit at the pool's request. This runs from the message loop, so no SDK code
 * is executing on this thread and it cannot hold a runtime lock. Stop
 * immediately so no pending callback can run SDK code afterwards. The adapter
 * reports the exit, and the pool then frees this thread's TLS and stack: a
 * thread must not destroy itself (see `worker_gate.rs`).
 */
function shutdown(): never {
  process.exit(0);
}

/**
 * Forward cache calls to the cache on the main thread. Byte arguments are
 * views of the SDK's shared memory, which the SDK keeps alive until the call
 * settles: posting one shares that memory, so the main thread reads or writes
 * the SDK's bytes in place.
 */
function installCacheProxy(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerNodeCacheOpen = (cacheId: number, path: string) =>
    callCache(cacheId, "open", [path]);
  scope.__wasmerNodeCacheReadInto = (
    cacheId: number,
    handle: number,
    destination: Uint8Array,
  ) => {
    if (!(destination.buffer instanceof SharedArrayBuffer)) {
      // A posted copy would be filled instead of the destination.
      return Promise.reject(
        new Error("Wasmer cache reads need a SharedArrayBuffer destination"),
      );
    }
    return callCache(cacheId, "readInto", [handle, destination]);
  };
  scope.__wasmerNodeCacheCloseFile = (cacheId: number, handle: number) =>
    callCache(cacheId, "closeFile", [handle]);
  scope.__wasmerNodeCachePut = (
    cacheId: number,
    path: string,
    bytes: Uint8Array,
  ) => callCache(cacheId, "put", [path, bytes]);
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
