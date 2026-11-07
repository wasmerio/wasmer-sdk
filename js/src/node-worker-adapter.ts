import {
  Worker as NodeWorker,
  type WorkerOptions as NodeWorkerOptions,
} from "node:worker_threads";
import {
  dispatchNodeNetworkCall,
  nodeNetworkBridge,
  type NodeNetworkMethod,
} from "./node-network.js";
import {
  dispatchNodeCacheCall,
  nodePackageCache,
  type NodeCacheMethod,
} from "./node-cache.js";
import { NETWORK_RPC_CONTROL_BYTES } from "./node-network-rpc.js";

interface WorkerEvent<T> {
  data: T;
}

interface NetworkRequest {
  type: "wasmer-network-rpc";
  bridgeId: number;
  method: NodeNetworkMethod;
  args: unknown[];
  response: SharedArrayBuffer;
}

interface CacheRequest {
  type: "wasmer-cache-rpc";
  cacheId: number;
  requestId: number;
  method: NodeCacheMethod;
  args: unknown[];
}

let workersCreated = 0;
let activeWorkers = 0;
let workerFailures = 0;
const liveAdapters = new Set<NodeWorkerAdapter>();
let nextStatsRequestId = 1;
const pendingStatsRequests = new Map<
  number,
  (stats: NodeWorkerGuestMemoryStats) => void
>();

/** Per-worker guest-memory counters, for tests. */
export interface NodeWorkerGuestMemoryStats {
  threadId: number;
  /** Guest memories created in the worker (with diagnostics enabled). */
  created?: number;
  finalized?: number;
  /** Guest memories not yet collected, live or dead. */
  liveCount?: number;
  liveBytes?: number;
  /** Dead guest memory the worker has not collected yet. */
  released: number;
  budgetCollections?: number;
  idleCollections?: number;
  collectionMs?: number;
  retirementRequests?: number;
}

/**
 * Ask every live worker for its guest-memory counters. Set
 * `globalThis.__wasmerGuestMemoryDiagnostics = true` before workers start to
 * get creation counts (`"no-collector"` also makes workers behave as if no
 * garbage-collection hook were available). Workers busy running a guest do
 * not answer within the timeout and are left out.
 */
export async function nodeWorkerGuestMemoryStats(
  timeoutMs = 1_000,
): Promise<NodeWorkerGuestMemoryStats[]> {
  const requests = [...liveAdapters].map(
    (adapter) =>
      new Promise<NodeWorkerGuestMemoryStats | undefined>((resolve) => {
        const requestId = nextStatsRequestId++;
        const timer = setTimeout(() => {
          pendingStatsRequests.delete(requestId);
          resolve(undefined);
        }, timeoutMs);
        pendingStatsRequests.set(requestId, (stats) => {
          clearTimeout(timer);
          resolve(stats);
        });
        adapter.postMessage({ type: "wasmer-guest-memory-stats", requestId });
      }),
  );
  return (await Promise.all(requests)).filter(
    (stats): stats is NodeWorkerGuestMemoryStats => stats !== undefined,
  );
}

export function nodeWorkerStats(): {
  workersCreated: number;
  activeWorkers: number;
  workerFailures: number;
} {
  return { workersCreated, activeWorkers, workerFailures };
}

/**
 * The DOM-shaped surface used by `web_sys::Worker`, backed by
 * `node:worker_threads`.
 */
export class NodeWorkerAdapter {
  onmessage: ((event: WorkerEvent<unknown>) => void) | null = null;
  onerror:
    | ((event: {
        message: string;
        filename: string;
        lineno: number;
        colno: number;
      }) => void)
    | null = null;

  readonly #worker: NodeWorker;
  #terminating = false;
  #failed = false;
  #exited = false;
  /**
   * The worker stops by itself: after its single task, or once the pool
   * retires it.
   */
  #retires = false;

  constructor(url: string, options: { name?: string; type?: string } = {}) {
    const workerOptions: NodeWorkerOptions = {
      name: options.name,
    };
    const diagnostics = (
      globalThis as { __wasmerGuestMemoryDiagnostics?: unknown }
    ).__wasmerGuestMemoryDiagnostics;
    if (diagnostics === true || diagnostics === "no-collector") {
      workerOptions.workerData = { wasmerGuestMemoryDiagnostics: diagnostics };
    }
    this.#worker = new NodeWorker(new URL(url), workerOptions);
    workersCreated += 1;
    activeWorkers += 1;
    liveAdapters.add(this);
    this.#worker.on("message", (data) => {
      if (isNetworkRequest(data)) {
        void respondToNetworkRequest(data);
      } else if (isRetiredMessage(data)) {
        // Reported from the exit event instead: the pool frees the thread's
        // TLS and stack on "retired", which is only safe once it has stopped.
      } else if (isStatsReply(data)) {
        pendingStatsRequests.get(data.requestId)?.(data.stats);
        pendingStatsRequests.delete(data.requestId);
      } else if (isCacheRequest(data)) {
        void respondToCacheRequest(this.#worker, data);
      } else {
        this.onmessage?.({ data });
      }
    });
    this.#worker.on("error", (error) => {
      this.#reportFailure(error);
    });
    this.#worker.on("exit", (code) => {
      activeWorkers -= 1;
      this.#exited = true;
      liveAdapters.delete(this);
      if (this.#retires && !this.#terminating && code === 0) {
        // A retiring worker exits by itself. Its thread has stopped, so the
        // pool may now free its TLS and stack.
        this.onmessage?.({ data: { type: "retired" } });
      } else if (this.#terminating) {
        // Tell the scheduler the worker is gone, as a browser worker does
        // itself before closing.
        this.onmessage?.({ data: { type: "exited" } });
      } else {
        this.#reportFailure(
          new Error(`Wasmer SDK worker exited unexpectedly with status ${code}`),
        );
      }
    });
  }

  #reportFailure(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    workerFailures += 1;
    console.error("Wasmer SDK worker error:", error);
    this.onerror?.({
      message: error.message,
      filename: "",
      lineno: 0,
      colno: 0,
    });
  }

  postMessage(message: unknown): void {
    const control = message as { type?: unknown; retireAfterTask?: unknown } | null;
    if (
      (control?.type === "init" && control.retireAfterTask === true) ||
      control?.type === "wasmer-retire"
    ) {
      this.#retires = true;
    }
    if ((message as { type?: unknown } | null)?.type === "wasmer-shutdown") {
      // The worker exits by itself; that exit is expected.
      this.#terminating = true;
      if (this.#exited) {
        // Already gone (e.g. it failed): report it instead of letting the
        // pool wait out its shutdown deadline.
        queueMicrotask(() => this.onmessage?.({ data: { type: "exited" } }));
        return;
      }
    }
    this.#worker.postMessage(message);
  }

  terminate(): void {
    this.#terminating = true;
    void this.#worker.terminate();
  }
}

function isStatsReply(
  value: unknown,
): value is { requestId: number; stats: NodeWorkerGuestMemoryStats } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-guest-memory-stats-reply"
  );
}

function isRetiredMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "retired"
  );
}

function isCacheRequest(value: unknown): value is CacheRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-cache-rpc"
  );
}

async function respondToCacheRequest(
  worker: NodeWorker,
  request: CacheRequest,
): Promise<void> {
  try {
    // Results are small: file bytes move through the request's shared views.
    const result = await dispatchNodeCacheCall(
      nodePackageCache(request.cacheId),
      request.method,
      request.args,
    );
    worker.postMessage({
      type: "wasmer-cache-rpc-response",
      requestId: request.requestId,
      ok: true,
      value: result,
    });
  } catch (error) {
    worker.postMessage({
      type: "wasmer-cache-rpc-response",
      requestId: request.requestId,
      ok: false,
      error: String(error),
    });
  }
}

function isNetworkRequest(value: unknown): value is NetworkRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-network-rpc"
  );
}

async function respondToNetworkRequest(request: NetworkRequest): Promise<void> {
  const control = new Int32Array(request.response, 0, 4);
  const payload = new Uint8Array(
    request.response,
    NETWORK_RPC_CONTROL_BYTES,
  );
  try {
    const result = await dispatchNodeNetworkCall(
      nodeNetworkBridge(request.bridgeId),
      request.method,
      request.args,
    );
    encodeResult(control, payload, result);
  } catch (error) {
    control[1] = 5;
    // Truncating is acceptable only here: this is a human-readable error
    // message, never data the caller will parse.
    control[2] = writeTruncatedText(payload, String(error));
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function encodeResult(
  control: Int32Array,
  payload: Uint8Array,
  result: unknown,
): void {
  if (result === undefined) {
    control[1] = 3;
    return;
  }
  if (result === null) {
    control[1] = 4;
    return;
  }
  if (result instanceof Uint8Array) {
    if (result.byteLength > payload.byteLength) {
      throw new Error(
        `network response is ${result.byteLength} bytes, exceeding ${payload.byteLength}`,
      );
    }
    control[1] = 2;
    control[2] = result.byteLength;
    payload.set(result);
    return;
  }
  control[1] = 1;
  control[2] = writeJson(payload, JSON.stringify(result));
}

/** Write a JSON result; a truncated JSON payload would parse as garbage. */
function writeJson(destination: Uint8Array, value: string): number {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > destination.byteLength) {
    throw new Error(
      `network response is ${encoded.byteLength} bytes, exceeding ${destination.byteLength}`,
    );
  }
  destination.set(encoded);
  return encoded.byteLength;
}

function writeTruncatedText(destination: Uint8Array, value: string): number {
  const encoded = new TextEncoder().encode(value);
  const length = Math.min(encoded.byteLength, destination.byteLength);
  destination.set(encoded.subarray(0, length));
  return length;
}
