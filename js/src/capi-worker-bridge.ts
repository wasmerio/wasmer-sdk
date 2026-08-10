type CapiObject = unknown;

interface CapiTransfer {
  registryId: number;
  handle: number;
  value: CapiObject;
}

interface WorkerDispatch {
  type: "wasmer-dispatch";
  payload: unknown;
  capiObjects: CapiTransfer[];
}

interface CapiDispatch {
  type: "wasmer-capi-dispatch";
  capiObjects: CapiTransfer[];
}

interface CapiDrop {
  type: "wasmer-capi-drop";
  registryId: number;
  handle: number;
}

const capiObjects = new Map<string, CapiObject>();
let capiMessageScope = 0;
const pendingCapiObjects = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();
const capiDispatchHandled = Symbol("wasmer.capi.dispatch.handled");

/** Install the synchronous bridge used by a nested WebAssembly C API guest. */
export function installCapiObjectBridge(
  send: (message: unknown) => void,
): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerCapiMessageScope = () => capiMessageScope;
  scope.__wasmerCapiShare = (
    registryId: number,
    handle: number,
    value: CapiObject,
  ) => {
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
  scope.__wasmerCapiObtain = (registryId: number, handle: number) => {
    const objectKey = key(registryId, handle);
    const value = capiObjects.get(objectKey);
    capiObjects.delete(objectKey);
    pendingCapiObjects.delete(objectKey);
    return value;
  };
  scope.__wasmerCapiWait = (registryId: number, handle: number) => {
    const objectKey = key(registryId, handle);
    if (capiObjects.has(objectKey)) {
      return Promise.resolve();
    }

    const existing = pendingCapiObjects.get(objectKey);
    if (existing) return existing.promise;

    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
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
  scope.__wasmerCapiDelete = (registryId: number, handle: number) => {
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
export function setCapiMessageWorkerId(workerId: number): void {
  if (!Number.isSafeInteger(workerId) || workerId < 0 || workerId >= 0xfff) {
    throw new RangeError(`Wasmer worker ID ${workerId} cannot be used as a C API message scope`);
  }
  capiMessageScope = workerId + 1;
}

/** Install attached host objects before dispatching a worker task. */
export function receiveCapiDispatch(data: unknown): unknown {
  if (isCapiDrop(data)) {
    const objectKey = key(data.registryId, data.handle);
    capiObjects.delete(objectKey);
    pendingCapiObjects.delete(objectKey);
    return capiDispatchHandled;
  }
  if (!isWorkerDispatch(data) && !isCapiDispatch(data)) return data;
  for (const transfer of data.capiObjects) {
    const objectKey = key(transfer.registryId, transfer.handle);
    capiObjects.set(objectKey, transfer.value);
    const pending = pendingCapiObjects.get(objectKey);
    pendingCapiObjects.delete(objectKey);
    pending?.resolve();
  }
  return isWorkerDispatch(data) ? data.payload : capiDispatchHandled;
}

export function isCapiDispatchHandled(value: unknown): boolean {
  return value === capiDispatchHandled;
}

function isWorkerDispatch(value: unknown): value is WorkerDispatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-dispatch" &&
    Array.isArray((value as { capiObjects?: unknown }).capiObjects)
  );
}

function isCapiDispatch(value: unknown): value is CapiDispatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-capi-dispatch" &&
    Array.isArray((value as { capiObjects?: unknown }).capiObjects)
  );
}

function isCapiDrop(value: unknown): value is CapiDrop {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-capi-drop" &&
    typeof (value as { registryId?: unknown }).registryId === "number" &&
    typeof (value as { handle?: unknown }).handle === "number"
  );
}

function key(registryId: number, handle: number): string {
  return `${registryId}:${handle}`;
}
