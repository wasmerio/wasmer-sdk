import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

const runtimeCache =
  process.env.WASMER_TEST_CACHE ??
  fileURLToPath(new URL("../../.wasmer", import.meta.url));

test("runs a registry WASIX package in the wasm-bindgen runtime", async () => {
  const client = new Wasmer({ cache: { directory: runtimeCache } });
  const sandbox = await client.sandboxes.create({
    packages: ["python/python@3.13.17"],
  });
  const output = await sandbox
    .command("python", ["-c", "print(sum(range(10)))"])
    .run();
  assert.equal(output.text(), "45\n");
  assert.equal(output.reason, "exited");
  assert.ok(output.ok);
  await sandbox.close();
  await client.close();

  const registryEntry = JSON.parse(
    await readFile(
      join(runtimeCache, "cache-v1", "registry", "python#python"),
      "utf8",
    ),
  );
  assert.equal(registryEntry.package_name, "python/python");
  assert.ok(Number.isSafeInteger(registryEntry.unix_timestamp));
  assert.equal(
    (
      await stat(
        join(
          runtimeCache,
          "cache-v1",
          "packages",
          "c03ebe0946e66edf598fd7a1f192101f60e4e9c0095aecd04e049989692bdcab.bin",
        ),
      )
    ).size,
    44_680_028,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("persistent package cache attempted network access");
  };
  const cachedClient = new Wasmer({ cache: { directory: runtimeCache } });
  try {
    const cached = await cachedClient.packages.load("python/python@3.13.17");
    assert.equal(cached.id, "python/python@3.13.17");
  } finally {
    await cachedClient.close();
    globalThis.fetch = originalFetch;
  }
});

test("keeps Wasmer.create as an eager compatibility factory", async () => {
  const client = await Wasmer.create();
  assert.equal(await client.ready(), client);
  await client.close();
});

test("reuses commands and preserves filesystem and stream semantics", async () => {
  const client = new Wasmer({ cache: { directory: runtimeCache } });
  let sandbox;
  try {
    sandbox = await client.sandboxes.create({
      packages: ["python/python@3.13.17"],
    });

    const command = sandbox.command("python", ["--version"]);
    assert.match((await command.run()).text(), /^Python 3\./);
    assert.match((await command.run()).text(), /^Python 3\./);

    const failing = sandbox.command("python", ["-c", "raise SystemExit(7)"]);
    await assert.rejects(
      failing.run(),
      (error) =>
        error?.name === "ProcessExitError" && error.output.exitCode === 7,
    );
    const unchecked = await failing.run({ check: false });
    assert.equal(unchecked.exitCode, 7);
    assert.equal(unchecked.reason, "exited");

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
    await withDeadline(
      terminable.terminate({ gracePeriodMs: 10_000 }),
      2_000,
      "terminate() waited through its configured grace period",
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
  const client = new Wasmer({ cache: { directory: runtimeCache } });
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

async function withDeadline(promise, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
