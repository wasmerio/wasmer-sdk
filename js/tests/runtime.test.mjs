import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

test("runs a registry WASIX package in the wasm-bindgen runtime", async () => {
  const client = new Wasmer();
  const sandbox = await client.sandboxes.create({
    packages: ["python/python@3.13.5"],
  });
  const output = await sandbox
    .command("python", ["-c", "print(sum(range(10)))"])
    .run({ check: true });
  assert.equal(output.text(), "45\n");
  assert.equal(output.reason, "exited");
  assert.ok(output.ok);
  await sandbox.close();
  await client.close();
});

test("keeps Wasmer.create as an eager compatibility factory", async () => {
  const client = await Wasmer.create();
  assert.equal(await client.ready(), client);
  await client.close();
});

test("reuses commands and preserves filesystem and stream semantics", async () => {
  const client = new Wasmer();
  let sandbox;
  try {
    sandbox = await client.sandboxes.create({
      packages: ["python/python@3.13.5"],
    });

    const command = sandbox.command("python", ["--version"]);
    assert.match((await command.run({ check: true })).text(), /^Python 3\./);
    assert.match((await command.run({ check: true })).text(), /^Python 3\./);

    await sandbox.fs.writeText("nested/original.txt", "hello");
    await sandbox.fs.rename("nested/original.txt", "nested/renamed.txt");
    assert.equal(await sandbox.fs.readText("nested/renamed.txt"), "hello");
    assert.deepEqual(
      (await sandbox.fs.readDir("nested")).map(({ name }) => name),
      ["renamed.txt"],
    );
    assert.deepEqual(await sandbox.fs.stat("nested/renamed.txt"), {
      kind: "file",
      size: 5,
    });
    await sandbox.fs.remove("nested", { recursive: true });

    const process = await sandbox
      .command("python", ["--version"])
      .spawn({ stderr: "discard" });
    const lines = [];
    for await (const line of process.stdout.lines()) lines.push(line);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Python 3\./);
    assert.ok((await process.wait()).ok);

    const terminable = await sandbox.command("python").spawn({
      stdin: "pipe",
      stdout: "discard",
      stderr: "discard",
    });
    const terminationStarted = performance.now();
    await terminable.terminate();
    assert.ok(
      performance.now() - terminationStarted < 750,
      "terminate() waited through its default grace period",
    );
    assert.equal((await terminable.wait()).reason, "terminated");

    const blocked = await sandbox.command("python").spawn({
      stdin: "pipe",
      stdout: "discard",
      stderr: "discard",
      timeoutMs: 25,
    });
    const timedOut = await blocked.wait();
    assert.equal(timedOut.reason, "timeout");
  } finally {
    await sandbox?.close();
    await client.close();
  }
});

test("ports.wait applies one wall-clock timeout", async () => {
  const port = await reservePort();
  const client = new Wasmer();
  let sandbox;
  try {
    sandbox = await client.sandboxes.create({
      network: { mode: "host" },
    });

    const started = performance.now();
    await assert.rejects(
      sandbox.ports.wait(port, { timeoutMs: 100 }),
      (error) => error?.code === "TIMEOUT",
    );
    assert.ok(performance.now() - started < 1_000);
  } finally {
    await sandbox?.close();
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
