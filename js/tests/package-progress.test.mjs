import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Wasmer } from "../dist/node.js";

const hello = await readFile(new URL("../../swift/Tests/WasmerSDKTests/Fixtures/hello.wasm", import.meta.url));

test("loadMany reports final snapshots, preserves order and counts no local download", async () => {
  const client = new Wasmer({ cache: false });
  try {
    const updates = [];
    const [pkg, duplicate] = await client.packages.loadMany([hello, hello], { onProgress: p => updates.push(p) });
    assert.equal(pkg.id, duplicate.id);
    assert.equal(updates.at(-1).phase, "ready");
    assert.deepEqual(updates.at(-1).download, { downloadedBytes: 0, totalBytes: 0, percent: 100 });
    assert.equal(updates.at(-1).packages.length, 1);
    updates.length = 0;
    assert.deepEqual(await client.packages.loadMany([], { onProgress: p => updates.push(p) }), []);
    assert.equal(updates.at(-1).phase, "ready");
    const sandbox = await client.sandboxes.create({ packages: [pkg], onPackageProgress: p => updates.push(p) });
    try {
      assert.equal(updates.at(-1).packages[0].id, pkg.id);
      assert.equal(updates.at(-1).packages[0].cached, true);
      updates.length = 0;
      await sandbox.installPackage(pkg, { onProgress: p => updates.push(p) });
      assert.equal(updates.at(-1).phase, "ready");
    } finally { await sandbox.close(); }
    const count = updates.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(updates.length, count, "no callbacks after settlement");
  } finally { await client.close(); }
});

test("observer failures detach without failing the load; pre-aborted loads stay silent", async () => {
  const client = new Wasmer({ cache: false });
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    let calls = 0;
    const pkg = await client.packages.load(hello, { onProgress() { calls++; throw new Error("observer test"); } });
    assert.equal(pkg.entrypoint, "main");
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.packages.load(hello, { signal: controller.signal, onProgress() { assert.fail("aborted"); } }), { name: "AbortError" });
  } finally { console.error = original; await client.close(); }
});
