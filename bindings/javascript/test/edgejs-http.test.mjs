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
    .spawn({ stdout: "pipe", stderr: "capture", outputBytes: 256 * 1024 });

  try {
    assert(process.stdout);
    await waitForLine(
      process.stdout.lines(),
      "Edge.js listening on",
      20_000,
    );
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
    const output = await process.wait();
    assert.equal(output.reason, "terminated");
    assert.equal(output.exitCode, 137);
    await waitForPortToClose(port);
    await sandbox.close();
    await client.close();
  }
});

test(
  "keeps two live clients on their own Node network bridges",
  { timeout: 60_000 },
  async () => {
    const first = await startServer("client-a");
    let second;
    try {
      second = await startServer("client-b");
      await assertServer(first, "client-a");
      await assertServer(second, "client-b");

      await closeServer(second);
      second = undefined;
      await assertServer(first, "client-a");
    } finally {
      if (second) await closeServer(second);
      await closeServer(first);
    }
  },
);

async function startServer(name) {
  const port = await reservePort();
  const client = new Wasmer();
  const edgejs = await client.loadPackage("wasmer/edgejs-quickjs@0.1.0");
  const source = new TextDecoder()
    .decode(serverSource)
    .replace("Hello from Edge.js!", name);
  const sandbox = await client.createSandbox({
    packages: [edgejs],
    files: { "server.js": source },
    env: { PORT: String(port) },
    network: { mode: "host" },
  });
  const process = await sandbox
    .command(edgejs, ["/workspace/server.js"])
    .spawn({ stdout: "pipe", stderr: "capture", outputBytes: 256 * 1024 });
  assert(process.stdout);
  await waitForLine(process.stdout.lines(), "Edge.js listening on", 20_000);
  return { client, sandbox, process, port };
}

async function assertServer(server, expected) {
  const response = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
    headers: { connection: "close" },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`<h1>${expected}</h1>`));
}

async function closeServer(server) {
  await server.process.kill();
  await server.process.wait();
  await server.sandbox.close();
  await server.client.close();
}

async function waitForLine(lines, marker, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      (async () => {
        for await (const line of lines) {
          if (line.includes(marker)) return;
        }
        throw new Error(`process exited before emitting ${marker}`);
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${marker}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPortToClose(port, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (await canConnect(port)) {
    if (performance.now() >= deadline) {
      assert.fail(`port ${port} remained open after the process was killed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
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
