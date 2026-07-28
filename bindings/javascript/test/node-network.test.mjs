import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { NodeNetworkBridge } from "../dist/node-network.js";

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
  const client = net.createConnection({ host: "127.0.0.1", port });
  await waitFor(() =>
    events.some(({ id, event }) => id === listener.id && event === "connection"),
  );

  const accepted = bridge.listenerAccept(listener.id);
  assert.ok(accepted);
  client.write("hello");
  await waitFor(() => bridge.socketReadable(accepted.id) > 0);
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
