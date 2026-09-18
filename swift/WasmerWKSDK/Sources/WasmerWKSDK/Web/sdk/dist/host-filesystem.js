/** Experimental worker-to-native filesystem protocol used by the iOS prototype. */
export const HOST_FS_MESSAGE = "wasmer-filesystem-rpc";
const RESPONSE_BYTES = 512 * 1024;
const HEADER_BYTES = 8;
const TIMEOUT_MS = 30_000;
export function isHostFileSystemRequest(value) {
    return typeof value === "object" && value !== null &&
        value.type === HOST_FS_MESSAGE;
}
export function installHostFileSystemWorkerBridge() {
    const scope = globalThis;
    scope.__wasmerHandleFileSystemRpc = (message) => {
        if (!isHostFileSystemRequest(message))
            return false;
        globalThis.postMessage(message);
        return true;
    };
    scope.__wasmerHostFileSystem = (mount, method, args) => {
        if (typeof window !== "undefined")
            throw new Error("Native filesystem calls require a worker");
        const response = new SharedArrayBuffer(RESPONSE_BYTES);
        const control = new Int32Array(response, 0, 2);
        globalThis.postMessage({ type: HOST_FS_MESSAGE, mount, method, args, response });
        if (Atomics.wait(control, 0, 0, TIMEOUT_MS) === "timed-out") {
            throw Object.assign(new Error(`Native filesystem ${method} timed out`), { code: "ETIMEDOUT" });
        }
        const bytes = new Uint8Array(response, HEADER_BYTES, control[1]).slice();
        const result = JSON.parse(new TextDecoder().decode(bytes));
        if (result.error)
            throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result.value;
    };
}
/** Always wake a waiting worker, including for bridge errors and oversized replies. */
export function respondToHostFileSystem(request, result) {
    const control = new Int32Array(request.response, 0, 2);
    let bytes = new TextEncoder().encode(JSON.stringify(result));
    if (bytes.length > request.response.byteLength - HEADER_BYTES) {
        bytes = new TextEncoder().encode(JSON.stringify({ error: { code: "EIO", message: "Native response exceeds bridge limit" } }));
    }
    new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
    control[1] = bytes.length;
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
}
//# sourceMappingURL=host-filesystem.js.map