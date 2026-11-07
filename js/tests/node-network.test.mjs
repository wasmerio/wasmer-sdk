import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installNodeCacheGlobals,
  NodePackageCache,
  nodePackageCache,
} from "../dist/node-cache.js";
import {
  installNodeNetworkGlobals,
  NodeNetworkBridge,
  nodeNetworkBridge,
} from "../dist/node-network.js";
import { networkResponseBufferBytes } from "../dist/node-network-rpc.js";

test("Node package caches are client-scoped and path-safe", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wasmer-sdk-node-cache-"));
  installNodeCacheGlobals();

  const first = new NodePackageCache(join(root, "first"));
  const second = new NodePackageCache(join(root, "second"));
  context.after(async () => {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.notEqual(first.id, second.id);
  assert.equal(nodePackageCache(first.id), first);

  // The SDK passes views of its shared memory and reads and writes them in
  // place.
  const memory = new Uint8Array(new SharedArrayBuffer(64));
  const path = "cache-v1/packages/abc.bin";
  memory.set(new TextEncoder().encode("package"), 8);
  await globalThis.__wasmerNodeCachePut(first.id, path, memory.subarray(8, 15));
  const opened = await globalThis.__wasmerNodeCacheOpen(first.id, path);
  assert.equal(opened.size, 7);
  assert.equal(
    await globalThis.__wasmerNodeCacheReadInto(
      first.id,
      opened.handle,
      memory.subarray(32, 32 + opened.size),
    ),
    7,
  );
  assert.equal(
    new TextDecoder().decode(memory.slice(32, 39)),
    "package",
  );
  await assert.rejects(
    globalThis.__wasmerNodeCacheReadInto(first.id, opened.handle, memory),
    /unknown Wasmer cache file/,
    "a read closes its file",
  );
  const unread = await globalThis.__wasmerNodeCacheOpen(first.id, path);
  await globalThis.__wasmerNodeCacheCloseFile(first.id, unread.handle);
  await assert.rejects(
    globalThis.__wasmerNodeCacheReadInto(first.id, unread.handle, memory),
    /unknown Wasmer cache file/,
  );
  assert.equal(
    await globalThis.__wasmerNodeCacheOpen(second.id, path),
    undefined,
  );
  assert.equal(
    new TextDecoder().decode(
      await readFile(join(root, "first", "cache-v1", "packages", "abc.bin")),
    ),
    "package",
  );
  await assert.rejects(
    first.put("../outside", new Uint8Array()),
    /invalid Wasmer cache path/,
  );
});

test("Node worker cache calls read and write shared memory in place", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wasmer-sdk-node-cache-"));
  const cache = new NodePackageCache(root);
  context.after(async () => {
    cache.close();
    await rm(root, { recursive: true, force: true });
  });
  // The adapter answers a worker's cache calls from the main thread.
  const { NodeWorkerAdapter } = await import("../dist/node-worker-adapter.js");
  const result = await new Promise((resolve, reject) => {
    const adapter = new NodeWorkerAdapter(
      new URL("./support/cache-rpc-worker.mjs", import.meta.url).href,
    );
    adapter.onmessage = ({ data }) => {
      if (data?.type === "result") {
        adapter.terminate();
        resolve(data);
      }
    };
    adapter.onerror = (error) => reject(new Error(error.message));
    adapter.postMessage({ type: "cache-id", cacheId: cache.id });
  });
  assert.deepEqual(result, {
    type: "result",
    size: 11,
    read: 11,
    text: "from worker",
  });
  assert.equal(
    await readFile(join(root, "cache-v1", "packages", "worker.bin"), "utf8"),
    "from worker",
  );
});

test("Node worker RPC buffers scale only with socket reads", () => {
  assert.equal(networkResponseBufferBytes("socketReadable", [1]), 528);
  assert.equal(networkResponseBufferBytes("socketClose", [1]), 528);
  assert.equal(networkResponseBufferBytes("socketRead", [1, 64]), 528);
  assert.equal(
    networkResponseBufferBytes("socketRead", [1, 1024 * 1024]),
    16 + 1024 * 1024,
  );
});

test("Node network bridge uses node:net for TCP", async (context) => {
  const server = net.createServer((socket) => socket.end("hello"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.notEqual(typeof address, "string");
  assert.ok(address);

  const bridge = new NodeNetworkBridge();
  let wake;
  const awakened = new Promise((resolve) => {
    wake = resolve;
  });
  bridge.setWakeCallback((_id, event) => {
    if (event === "readable" || event === "close") wake();
  });

  const descriptor = await bridge.connectTcp(
    "0.0.0.0:0",
    `127.0.0.1:${address.port}`,
  );
  await awakened;
  assert.equal(
    new TextDecoder().decode(bridge.socketRead(descriptor.id, 64)),
    "hello",
  );
  bridge.socketClose(descriptor.id);
});

test("Node network bridge uses node:dns", async () => {
  const bridge = new NodeNetworkBridge();
  const addresses = await bridge.resolve("localhost");
  assert.ok(addresses.length > 0);
});

test("Node network bridge exposes a synchronous WASIX TCP listener", async () => {
  const port = await reservePort();
  const bridge = new NodeNetworkBridge();
  const events = [];
  let wake;
  bridge.setWakeCallback((id, event) => {
    events.push({ id, event });
    wake?.();
  });

  const listener = bridge.listenTcp(`127.0.0.1:${port}`);
  assert.equal(bridge.listenerReadable(listener.id), false);
  const client = net.createConnection({ host: "127.0.0.1", port });
  await waitFor(() =>
    events.some(({ id, event }) => id === listener.id && event === "connection"),
  );
  assert.equal(bridge.listenerReadable(listener.id), true);

  const listenerEventCount = events.length;
  bridge.listenerRefresh(listener.id);
  await waitFor(() => events.length > listenerEventCount);
  assert.deepEqual(events.at(-1), {
    id: listener.id,
    event: "connection",
  });

  const accepted = bridge.listenerAccept(listener.id);
  assert.ok(accepted);
  assert.equal(bridge.listenerReadable(listener.id), false);
  client.write("hello");
  await waitFor(() => bridge.socketReadable(accepted.id) > 0);

  const socketReadableCount = events.filter(
    ({ id, event }) => id === accepted.id && event === "readable",
  ).length;
  bridge.socketRefresh(accepted.id);
  await waitFor(
    () =>
      events.filter(
        ({ id, event }) => id === accepted.id && event === "readable",
      ).length > socketReadableCount,
  );
  assert.equal(
    new TextDecoder().decode(bridge.socketRead(accepted.id, 64)),
    "hello",
  );

  client.destroy();
  bridge.socketClose(accepted.id);
  bridge.listenerClose(listener.id);

  function waitFor(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      wake = () => {
        if (!predicate()) return;
        wake = undefined;
        resolve();
      };
    });
  }
});

test("Node network bridge close releases listeners and accepted sockets", async () => {
  const port = await reservePort();
  const bridge = new NodeNetworkBridge();
  let wake;
  bridge.setWakeCallback((_id, event) => {
    if (event === "writable" || event === "connection") wake?.();
  });

  bridge.listenTcp(`127.0.0.1:${port}`);
  await waitForWake();
  const client = net.createConnection({ host: "127.0.0.1", port });
  await waitForWake();

  bridge.close();
  await new Promise((resolve) => client.once("close", resolve));

  const replacement = net.createServer();
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    replacement.close((error) => (error ? reject(error) : resolve())),
  );

  function waitForWake() {
    return new Promise((resolve) => {
      wake = () => {
        wake = undefined;
        resolve();
      };
    });
  }
});

test("global Node network hooks route colliding descriptors by bridge ID", async () => {
  const firstPort = await reservePort();
  const secondPort = await reservePort();
  const first = new NodeNetworkBridge();
  const second = new NodeNetworkBridge();
  assert.notEqual(first.id, second.id);
  assert.equal(nodeNetworkBridge(first.id), first);
  assert.equal(nodeNetworkBridge(second.id), second);
  installNodeNetworkGlobals();

  const firstReady = bridgeEvent(first, "writable");
  const secondReady = bridgeEvent(second, "writable");
  const firstListener = globalThis.__wasmerHostListenTcp(
    first.id,
    `127.0.0.1:${firstPort}`,
  );
  const secondListener = globalThis.__wasmerHostListenTcp(
    second.id,
    `127.0.0.1:${secondPort}`,
  );
  assert.equal(firstListener.id, secondListener.id);
  await Promise.all([firstReady, secondReady]);

  globalThis.__wasmerHostListenerClose(first.id, firstListener.id);
  const rebound = net.createServer();
  await new Promise((resolve, reject) => {
    rebound.once("error", reject);
    rebound.listen(firstPort, "127.0.0.1", resolve);
  });

  const secondClient = net.createConnection({
    host: "127.0.0.1",
    port: secondPort,
  });
  await new Promise((resolve, reject) => {
    secondClient.once("connect", resolve);
    secondClient.once("error", reject);
  });

  secondClient.destroy();
  await new Promise((resolve, reject) =>
    rebound.close((error) => (error ? reject(error) : resolve())),
  );
  second.close();
  first.close();
  assert.throws(() => nodeNetworkBridge(first.id), /unknown or closed/);
});

function bridgeEvent(bridge, expected) {
  return new Promise((resolve) => {
    bridge.setWakeCallback((_id, event) => {
      if (event === expected) resolve();
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
