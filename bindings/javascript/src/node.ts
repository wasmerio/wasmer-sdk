import { readFile } from "node:fs/promises";

import init, * as core from "../pkg/wasmer_sdk_js.js";
import {
  Wasmer as BrowserWasmer,
  type WasmerOptions,
} from "./index.js";
import {
  installNodeNetworkGlobals,
  NodeNetworkBridge,
} from "./node-network.js";
import {
  configureNodeWorkerBridge,
  NodeWorkerAdapter,
} from "./node-worker-adapter.js";

export * from "./index.js";

let nodeInitialization: Promise<void> | undefined;
const nodeNetworks = new WeakMap<core.WasmerCore, NodeNetworkBridge>();

/**
 * Node entrypoint. WASIX TCP listeners, outbound TCP connections, and DNS are
 * backed directly by `node:net` and `node:dns`; no native addon is involved.
 */
export class Wasmer extends BrowserWasmer {
  protected static override async initializeCore(
    options: WasmerOptions,
  ): Promise<core.WasmerCore> {
    nodeInitialization ??= (async () => {
      const wasm =
        options.wasm ??
        (await readFile(
          new URL("../pkg/wasmer_sdk_js_bg.wasm", import.meta.url),
        ));
      await init({ module_or_path: wasm as never });
    })()
      .catch((error: unknown) => {
        nodeInitialization = undefined;
        throw error;
      });
    await nodeInitialization;
    const network = new NodeNetworkBridge();
    installNodeNetworkGlobals(network);
    configureNodeWorkerBridge(network);
    installNodeWorkers();
    const client = core.WasmerCore.create(
      { outputBytes: options.outputBytes },
      network,
    );
    nodeNetworks.set(client, network);
    return client;
  }

  protected override async closeCore(client: core.WasmerCore): Promise<void> {
    try {
      await super.closeCore(client);
    } finally {
      nodeNetworks.get(client)?.close();
      nodeNetworks.delete(client);
    }
  }
}

function installNodeWorkers(): void {
  if (!("Worker" in globalThis)) {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: NodeWorkerAdapter,
    });
  }
  const workerConfig = core as typeof core & {
    setSDKUrl(url: string): void;
    setWorkerUrl(url: string): void;
  };
  workerConfig.setSDKUrl(
    new URL("../pkg/wasmer_sdk_js.js", import.meta.url).href,
  );
  workerConfig.setWorkerUrl(new URL("./node-worker.js", import.meta.url).href);
}
