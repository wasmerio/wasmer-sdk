import { readFile } from "node:fs/promises";

import init, * as core from "../pkg/wasmer_sdk_js.js";
import {
  Wasmer as BrowserWasmer,
  WasmerError,
  type WasmerOptions,
} from "./index.js";
import {
  installNodeCacheGlobals,
  NodePackageCache,
} from "./node-cache.js";
import {
  installNodeNetworkGlobals,
  NodeNetworkBridge,
} from "./node-network.js";
import { NodeWorkerAdapter } from "./node-worker-adapter.js";

export * from "./index.js";

let nodeInitialization: Promise<void> | undefined;
const nodeNetworks = new WeakMap<core.WasmerCore, NodeNetworkBridge>();
const nodeCaches = new WeakMap<core.WasmerCore, NodePackageCache>();

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
    installNodeNetworkGlobals();
    installNodeCacheGlobals();
    installNodeWorkers();
    const cache = createNodeCache(options.cache);
    const network = new NodeNetworkBridge();
    try {
      const client = core.WasmerCore.create(
        {
          outputBytes: options.outputBytes,
          parallelism: options.parallelism,
          cache: {
            mode:
              options.cache === false
                ? "disabled"
                : options.cache === "memory"
                  ? "memory"
                  : "node",
          },
        },
        network,
        cache,
      );
      nodeNetworks.set(client, network);
      if (cache) nodeCaches.set(client, cache);
      return client;
    } catch (error) {
      network.close();
      cache?.close();
      throw error;
    }
  }

  protected override async closeCore(client: core.WasmerCore): Promise<void> {
    try {
      await super.closeCore(client);
    } finally {
      nodeNetworks.get(client)?.close();
      nodeNetworks.delete(client);
      nodeCaches.get(client)?.close();
      nodeCaches.delete(client);
    }
  }
}

function createNodeCache(
  options: WasmerOptions["cache"],
): NodePackageCache | undefined {
  if (options === false || options === "memory") return undefined;
  if (options?.namespace !== undefined) {
    throw new WasmerError(
      "`cache.namespace` is only available from the browser entrypoint",
      "INVALID_ARGUMENT",
    );
  }
  return new NodePackageCache(
    options?.directory ?? ".wasmer",
    options?.readOnly ?? false,
  );
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
