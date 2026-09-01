import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";

import { Wasmer } from "@wasmer/sdk/node";

const serverSource = await readFile(
  new URL("../../fixtures/edgejs/server.js", import.meta.url),
);
const port = await reservePort();
const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/edgejs@0.2.0"],
  files: { "server.js": serverSource },
  env: { PORT: String(port) },
  network: { mode: "host" },
});
const guest = await sandbox
  .command("edge", ["/workspace/server.js"])
  .spawn({ stdout: "pipe", stderr: "capture" });

try {
  assert(guest.stdout);
  await waitForLine(guest.stdout.lines(), "Edge.js listening on", 20_000);

  const response = await fetch(`http://127.0.0.1:${port}/hello`, {
    headers: { connection: "close" },
  });
  console.log(`GET /hello -> ${response.status}`);
  console.log(await response.text());
} finally {
  await guest.terminate({ gracePeriodMs: 2_000 });
  await guest.wait();
  await sandbox.close();
  await wasmer.close();
}

async function waitForLine(lines, marker, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      (async () => {
        for await (const line of lines) {
          console.log(line);
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

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
