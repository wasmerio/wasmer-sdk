import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

const serverSource = await readFile(
  new URL("../../../examples/edgejs-http/server.js", import.meta.url),
);

test("serves HTTP from EdgeJS QuickJS through the Node network bridge", async () => {
  const port = await reservePort();
  const wasmer = await Wasmer.create();
  const edgejs = await wasmer.loadPackage("wasmer/edgejs-quickjs");
  const sandbox = await wasmer.createSandbox({
    packages: [edgejs],
    files: { "server.js": serverSource },
    network: true,
  });
  const process = await sandbox
    .command(edgejs, ["/workspace/server.js"], {
      env: { PORT: String(port) },
      outputBytes: 256 * 1024,
    })
    .spawn();

  try {
    const response = await fetchUntilReady(`http://127.0.0.1:${port}/hello`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Hello from Edge\.js!<\/h1>/);
  } finally {
    await process.kill();
    await process.wait();
    await sandbox.close();
    await wasmer.shutdown();
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

async function fetchUntilReady(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`unexpected HTTP status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`);
}
