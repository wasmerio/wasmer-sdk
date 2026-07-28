import {
  Worker as NodeWorker,
  type WorkerOptions as NodeWorkerOptions,
} from "node:worker_threads";
import {
  dispatchNodeNetworkCall,
  nodeNetworkBridge,
  type NodeNetworkMethod,
} from "./node-network.js";
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

let workersCreated = 0;
let activeWorkers = 0;

export function nodeWorkerStats(): {
  workersCreated: number;
  activeWorkers: number;
} {
  return { workersCreated, activeWorkers };
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

  constructor(url: string, options: { name?: string; type?: string } = {}) {
    const workerOptions: NodeWorkerOptions = {
      name: options.name,
    };
    this.#worker = new NodeWorker(new URL(url), workerOptions);
    workersCreated += 1;
    activeWorkers += 1;
    this.#worker.on("message", (data) => {
      if (isNetworkRequest(data)) {
        void respondToNetworkRequest(data);
      } else {
        this.onmessage?.({ data });
      }
    });
    this.#worker.on("error", (error) => {
      console.error("Wasmer SDK worker error:", error);
      this.onerror?.({
        message: error.message,
        filename: "",
        lineno: 0,
        colno: 0,
      });
    });
    this.#worker.on("exit", (code) => {
      activeWorkers -= 1;
      if (!this.#terminating && code !== 0) {
        console.error(`Wasmer SDK worker exited with status ${code}`);
      }
    });
  }

  postMessage(message: unknown): void {
    this.#worker.postMessage(message);
  }

  terminate(): void {
    this.#terminating = true;
    void this.#worker.terminate();
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
