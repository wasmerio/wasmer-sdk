const capiObjects = new Map();
let capiMessageScope = 0;
const pendingCapiObjects = new Map();
const capiDispatchHandled = Symbol("wasmer.capi.dispatch.handled");
/** Install the synchronous bridge used by a nested WebAssembly C API guest. */
export function installCapiObjectBridge(send) {
    const scope = globalThis;
    scope.__wasmerCapiMessageScope = () => capiMessageScope;
    scope.__wasmerCapiShare = (registryId, handle, value) => {
        // Worker.postMessage() is the serializer. Keeping the original in this
        // realm makes the handle valid until Edge releases it, while the browser
        // performs the structured clone used by every destination realm.
        send({
            type: "wasmer-capi-share",
            registryId,
            handle,
            value,
        });
        capiObjects.set(key(registryId, handle), value);
    };
    scope.__wasmerCapiObtain = (registryId, handle) => {
        const objectKey = key(registryId, handle);
        const value = capiObjects.get(objectKey);
        capiObjects.delete(objectKey);
        pendingCapiObjects.delete(objectKey);
        return value;
    };
    scope.__wasmerCapiWait = (registryId, handle) => {
        const objectKey = key(registryId, handle);
        if (capiObjects.has(objectKey)) {
            return Promise.resolve();
        }
        const existing = pendingCapiObjects.get(objectKey);
        if (existing)
            return existing.promise;
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        pendingCapiObjects.set(objectKey, { promise, resolve });
        send({
            type: "wasmer-capi-request",
            registryId,
            handle,
        });
        return promise;
    };
    scope.__wasmerCapiDelete = (registryId, handle) => {
        const objectKey = key(registryId, handle);
        capiObjects.delete(objectKey);
        pendingCapiObjects.delete(objectKey);
        send({
            type: "wasmer-capi-delete",
            registryId,
            handle,
        });
    };
}
/**
 * Give guest-defined opaque message handles a scheduler-wide namespace.
 *
 * Each worker instantiates its own copy of a guest WebAssembly module, so a
 * module-local counter alone is not unique. Scope zero is reserved for hosts
 * which execute without the SDK worker pool; worker N uses scope N + 1.
 */
export function setCapiMessageWorkerId(workerId) {
    if (!Number.isSafeInteger(workerId) || workerId < 0 || workerId >= 0xfff) {
        throw new RangeError(`Wasmer worker ID ${workerId} cannot be used as a C API message scope`);
    }
    capiMessageScope = workerId + 1;
}
/** Install attached host objects before dispatching a worker task. */
export function receiveCapiDispatch(data) {
    if (isCapiDrop(data)) {
        const objectKey = key(data.registryId, data.handle);
        capiObjects.delete(objectKey);
        pendingCapiObjects.delete(objectKey);
        return capiDispatchHandled;
    }
    if (!isWorkerDispatch(data) && !isCapiDispatch(data))
        return data;
    for (const transfer of data.capiObjects) {
        const objectKey = key(transfer.registryId, transfer.handle);
        capiObjects.set(objectKey, transfer.value);
        const pending = pendingCapiObjects.get(objectKey);
        pendingCapiObjects.delete(objectKey);
        pending?.resolve();
    }
    return isWorkerDispatch(data) ? data.payload : capiDispatchHandled;
}
export function isCapiDispatchHandled(value) {
    return value === capiDispatchHandled;
}
function isWorkerDispatch(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.type === "wasmer-dispatch" &&
        Array.isArray(value.capiObjects));
}
function isCapiDispatch(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.type === "wasmer-capi-dispatch" &&
        Array.isArray(value.capiObjects));
}
function isCapiDrop(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.type === "wasmer-capi-drop" &&
        typeof value.registryId === "number" &&
        typeof value.handle === "number");
}
function key(registryId, handle) {
    return `${registryId}:${handle}`;
}
//# sourceMappingURL=capi-worker-bridge.js.map