/** Experimental worker-to-native filesystem protocol used by the iOS prototype. */
export const HOST_FS_MESSAGE = "wasmer-filesystem-rpc";
const RESPONSE_BYTES = 512 * 1024;
const HEADER_BYTES = 8;
const TIMEOUT_MS = 30_000;

export interface HostFileSystemRequest {
  type: typeof HOST_FS_MESSAGE;
  mount: number;
  method: string;
  args: unknown[];
  response: SharedArrayBuffer;
  /** Worker accepts raw byte replies; older embedders can still reply with JSON. */
  binary?: boolean;
}

export function isHostFileSystemRequest(value: unknown): value is HostFileSystemRequest {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === HOST_FS_MESSAGE;
}

export function installHostFileSystemWorkerBridge(route?: (request: HostFileSystemRequest) => boolean): void {
  // Calls block this worker, so only one reply can be in flight. Reuse its
  // storage: pip performs tens of thousands of metadata calls; reserving
  // 512 KiB for every call creates gigabytes of transient shared buffers.
  let responseBuffer: SharedArrayBuffer | undefined;
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerHandleFileSystemRpc = (message: unknown) => {
    if (!isHostFileSystemRequest(message)) return false;
    if (!route?.(message)) globalThis.postMessage(message);
    return true;
  };
  scope.__wasmerHostFileSystem = (mount: number, method: string, args: unknown[]) => {
    if (typeof window !== "undefined") throw new Error("Native filesystem calls require a worker");
    const response = responseBuffer ??= new SharedArrayBuffer(RESPONSE_BYTES);
    const control = new Int32Array(response, 0, 2);
    control.fill(0);
    const request: HostFileSystemRequest = { type: HOST_FS_MESSAGE, mount, method, args, response, binary: true };
    if (!route?.(request)) globalThis.postMessage(request);
    const deadline = Date.now() + TIMEOUT_MS;
    // A notification from the preceding reply can race with buffer reuse.
    // Always check the completion flag rather than treating a wake as a reply.
    while (Atomics.load(control, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(control, 0, 0, remaining) === "timed-out") {
        // A late host reply still owns this buffer. Never let it overwrite the
        // next call's response after a timeout.
        responseBuffer = undefined;
        throw Object.assign(new Error(`Native filesystem ${method} timed out`), { code: "ETIMEDOUT" });
      }
    }
    const bytes = new Uint8Array(response, HEADER_BYTES, control[1]).slice();
    if (Atomics.load(control, 0) === 2) return bytes;
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  };
}

/** Always wake a waiting worker, including for bridge errors and oversized replies. */
export function respondToHostFileSystem(request: HostFileSystemRequest, result: unknown): void {
  const control = new Int32Array(request.response, 0, 2);
  const reply = result as { value?: unknown; error?: unknown } | null;
  const value = reply?.value;
  let binary = request.binary === true && !reply?.error && value instanceof Uint8Array;
  // Keep JSON compatibility for old workers while avoiding numeric JSON for
  // binary reads. The worker copies these bytes before reusing its reply buffer.
  let bytes = binary ? value as Uint8Array : new TextEncoder().encode(JSON.stringify(
    value instanceof Uint8Array ? { ...reply, value: Array.from(value) } : result));
  if (bytes.length > request.response.byteLength - HEADER_BYTES) {
    binary = false;
    bytes = new TextEncoder().encode(JSON.stringify({ error: { code: "EIO", message: "Native response exceeds bridge limit" } }));
  }
  new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
  control[1] = bytes.length;
  Atomics.store(control, 0, binary ? 2 : 1);
  Atomics.notify(control, 0);
}
