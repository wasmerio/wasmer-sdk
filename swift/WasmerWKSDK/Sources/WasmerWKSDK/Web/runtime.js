import "./node-compat.js";
import { installHostFileSystemWorkerBridge } from "./sdk/dist/host-filesystem.js";
import { createRuntimeMemory, configureGuestMemory } from "./memory-budget.js";
import { probeJSPI } from "./jspi.js";
import { installDiagnostics } from "./diagnostics.js";
import { NativeNetworkBridge, installNativeNetworkGlobals, receiveNativeNetworkReply } from "./native-network.js";
import { OPFSStorage } from "./opfs-bridge.js";
import { SDKDispatcher, errorValue } from "./rpc-dispatch.js";

configureGuestMemory(location.href);
// WebKit may keep shared-memory reservations until every importing realm is
// collected. Reclaim a guest realm when its WASIX thread has fully completed.
globalThis.__wasmerWorkerPerThread = true;
const storage = new OPFSStorage();
installHostFileSystemWorkerBridge(request => storage.route(request));
installDiagnostics();
const browserFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input), import.meta.url);
  const match = /^https:\/\/cdn\.wasmer\.io\/webcimages\/([a-f0-9]{64}\.webc)$/.exec(url.href);
  return match ? browserFetch(new URL(`./__packages/${match[1]}`, import.meta.url)) : browserFetch(input, options);
};
const capabilities = probeJSPI();
void capabilities.then(jspi => postMessage({ kind: "ready", workerIsolated: crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer === "function", ...jspi }));
const dispatcher = new SDKDispatcher(async options => {
  const support = await capabilities;
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== "function" || !support.jspi) {
    throw Object.assign(new Error(support.jspiError ?? "WebKit requires cross-origin isolation and SharedArrayBuffer"), { code: "CAPABILITY_UNAVAILABLE" });
  }
  const sdk = await import("./sdk/pkg/wasmer_sdk_js.js");
  await sdk.default({ memory: createRuntimeMemory() });
  sdk.setSDKUrl(new URL("./sdk/pkg/wasmer_sdk_js.js", import.meta.url).href);
  const guestURL = new URL("./guest-worker.js", import.meta.url);
  guestURL.search = location.search;
  sdk.setWorkerUrl(guestURL.href);
  return sdk.WasmerCore.create({ parallelism: 1, cache: { mode: "memory" }, outputBytes: options.outputBytes ?? 16 * 1024 * 1024 });
}, () => {
  const network = new NativeNetworkBridge();
  installNativeNetworkGlobals(network);
  return network;
}, storage);
onmessage = async ({ data }) => {
  if (data.kind === "storage-close") {
    try { await storage.closeAll(); postMessage({id:data.id, value:true}); }
    catch (error) { postMessage({id:data.id, error:errorValue(error)}); }
    return;
  }
  if (receiveNativeNetworkReply(data)) return;
  if (data.kind === "cancel") { dispatcher.cancel(data.id); return; }
  try { postMessage({ id: data.id, value: await dispatcher.request(data.id, data.method, data.args) }); }
  catch (error) { postMessage({ id: data.id, error: errorValue(error) }); }
};
