import { installHostFileSystemWorkerBridge } from "./host-filesystem.js";
import { NETWORK_RPC_CONTROL_BYTES, networkResponseBufferBytes, } from "./node-network-rpc.js";
import { installCapiObjectBridge, isCapiDispatchHandled, receiveCapiDispatch, setCapiMessageWorkerId, } from "./capi-worker-bridge.js";
Error.stackTraceLimit = 50;
installNetworkProxy();
installHostFileSystemWorkerBridge();
installCapiObjectBridge((message) => globalThis.postMessage(message));
let runtimeMemory;
globalThis.addEventListener("error", (event) => {
    console.error("[wasmer-sdk-worker-error]", runtimeMemory?.buffer.byteLength, event.error?.stack ?? event.message);
});
globalThis.addEventListener("unhandledrejection", (event) => {
    console.error("[wasmer-sdk-worker-rejection]", event.reason?.stack ?? event.reason);
});
let worker;
const pendingMessages = [];
globalThis.onmessage = ({ data }) => {
    void handleMessage(data).catch((error) => {
        console.error("Wasmer SDK worker failed:", error);
    });
};
async function handleMessage(data) {
    data = receiveCapiDispatch(data);
    if (isCapiDispatchHandled(data))
        return;
    if (isInitMessage(data)) {
        runtimeMemory = data.memory;
        await initialize(data);
        return;
    }
    if (worker) {
        await worker.handle(data);
    }
    else
        pendingMessages.push(data);
}
async function initialize(data) {
    setCapiMessageWorkerId(data.id);
    const sdk = (await import(/* @vite-ignore */ data.sdkUrl));
    await sdk.default({ module_or_path: data.module, memory: data.memory });
    const initialized = new sdk.ThreadPoolWorker(data.id);
    worker = initialized;
    while (pendingMessages.length > 0) {
        void initialized.handle(pendingMessages.shift()).catch((error) => {
            console.error("Wasmer SDK worker failed:", error);
        });
    }
}
function installNetworkProxy() {
    const scope = globalThis;
    scope.__wasmerHostResolveSync = (bridgeId, host) => callNetwork(bridgeId, "resolve", [host]);
    scope.__wasmerHostConnectTcpSync = (bridgeId, local, peer) => callNetwork(bridgeId, "connectTcp", [local, peer]);
    scope.__wasmerHostSocketRead = (bridgeId, id, maximum) => callNetwork(bridgeId, "socketRead", [id, maximum]);
    scope.__wasmerHostSocketWrite = (bridgeId, id, bytes) => callNetwork(bridgeId, "socketWrite", [id, bytes]);
    scope.__wasmerHostSocketFlush = (bridgeId, id) => callNetwork(bridgeId, "socketFlush", [id]);
    scope.__wasmerHostSocketClose = (bridgeId, id) => callNetwork(bridgeId, "socketClose", [id]);
    scope.__wasmerHostSocketReadable = (bridgeId, id) => callNetwork(bridgeId, "socketReadable", [id]);
    scope.__wasmerHostSocketWritable = (bridgeId, id) => callNetwork(bridgeId, "socketWritable", [id]);
    scope.__wasmerHostSocketSetNoDelay = (bridgeId, id, enabled) => callNetwork(bridgeId, "socketSetNoDelay", [id, enabled]);
    scope.__wasmerHostSocketSetKeepAlive = (bridgeId, id, enabled) => callNetwork(bridgeId, "socketSetKeepAlive", [id, enabled]);
    scope.__wasmerHostSocketRefresh = (bridgeId, id) => callNetwork(bridgeId, "socketRefresh", [id]);
}
function callNetwork(bridgeId, method, args) {
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
function decodeShared(bytes) {
    // Browser TextDecoder rejects views backed by SharedArrayBuffer. Copy the
    // small RPC control payload into an ordinary ArrayBuffer before decoding.
    return new TextDecoder().decode(bytes.slice());
}
function isInitMessage(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.type === "init");
}
//# sourceMappingURL=browser-worker.js.map