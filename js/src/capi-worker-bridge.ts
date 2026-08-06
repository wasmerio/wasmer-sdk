type CapiObject = WebAssembly.Module | WebAssembly.Memory;

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

const capiObjects = new Map<string, CapiObject>();

/** Install the synchronous bridge used by a nested WebAssembly C API guest. */
export function installCapiObjectBridge(
  send: (message: unknown) => void,
): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerCapiShare = (
    registryId: number,
    handle: number,
    value: CapiObject,
  ) => {
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
    return value;
  };
  scope.__wasmerCapiDelete = (registryId: number, handle: number) => {
    capiObjects.delete(key(registryId, handle));
    send({
      type: "wasmer-capi-delete",
      registryId,
      handle,
    });
  };
}

/** Install attached host objects before dispatching a worker task. */
export function receiveCapiDispatch(data: unknown): unknown {
  if (!isWorkerDispatch(data)) return data;
  for (const transfer of data.capiObjects) {
    capiObjects.set(key(transfer.registryId, transfer.handle), transfer.value);
  }
  return data.payload;
}

function isWorkerDispatch(value: unknown): value is WorkerDispatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-dispatch" &&
    Array.isArray((value as { capiObjects?: unknown }).capiObjects)
  );
}

function key(registryId: number, handle: number): string {
  return `${registryId}:${handle}`;
}
