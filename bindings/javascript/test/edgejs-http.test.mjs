import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

const serverSource = await readFile(
  new URL("../../../examples/edgejs-http/server.js", import.meta.url),
);

test("serves HTTP from EdgeJS QuickJS through the Node network bridge", async (context) => {
  const port = await reservePort();
  const client = new Wasmer();
  const edgejs = await client.loadPackage("wasmer/edgejs-quickjs@0.1.0");
  const sandbox = await client.createSandbox({
    packages: [edgejs],
    files: { "server.js": serverSource },
    env: { PORT: String(port) },
    network: { mode: "host" },
  });
  const process = await sandbox
    .command(edgejs, ["/workspace/server.js"])
    .spawn({ stdout: "capture", stderr: "capture", outputBytes: 256 * 1024 });

  try {
    await sandbox.ports.wait(port, { timeoutMs: 20_000 });
    const requestStarted = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/hello`, {
      headers: { connection: "close" },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Hello from Edge\.js!<\/h1>/);
    const requestElapsed = performance.now() - requestStarted;
    assert.ok(
      requestElapsed < 5_000,
      `HTTP request took ${requestElapsed.toFixed(0)}ms after the port was ready`,
    );
    context.diagnostic(
      `HTTP response after port readiness: ${requestElapsed.toFixed(0)}ms`,
    );
  } finally {
    await process.kill();
    await process.wait();
    await sandbox.close();
    await client.close();
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
