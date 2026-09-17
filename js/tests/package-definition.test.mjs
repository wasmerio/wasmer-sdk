import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Wasmer } from "../dist/node.js";

const fixture = await readFile(new URL("../../rust/tests/fixtures/package-files.wasm", import.meta.url));

function definition(bytes = fixture) {
  return {
    modules: { app: bytes },
    commands: { hello: { module: "app" } },
    files: { "/data/input.txt": "original" },
  };
}

test("creates reusable packages with isolated bundled files and snapshots input", async () => {
  const client = new Wasmer({ cache: false });
  const sandboxes = [];
  try {
    const bytes = Buffer.from(fixture);
    const input = definition(bytes);
    const pending = client.packages.create(input);
    bytes.fill(0);
    input.commands.hello.module = "missing";
    input.files["/data/input.txt"] = "mutated";
    const pkg = await pending;
    assert.deepEqual(pkg.commands, ["hello"]);
    assert.equal(pkg.entrypoint, "hello");
    const a = await client.sandboxes.create({ packages: [pkg] });
    sandboxes.push(a);
    const b = await client.sandboxes.create();
    sandboxes.push(b);
    await b.installPackage(pkg);
    for (const sandbox of [a, b, a]) {
      assert.equal((await sandbox.command(pkg).run()).text(), "original");
    }
    assert.equal((await b.command(pkg.command("hello")).run()).text(), "original");
  } finally {
    for (const sandbox of sandboxes) await sandbox.close();
    await client.close();
  }
});

test("package identity and entrypoints include command and file definitions", async () => {
  const client = new Wasmer({ cache: false });
  let sandbox;
  try {
    const input = definition();
    input.commands.alias = { module: "app" };
    const pkg = await client.packages.create(input);
    assert.equal(pkg.entrypoint, undefined);
    const reordered = await client.packages.create({
      ...input, commands: { alias: { module: "app" }, hello: { module: "app" } },
    });
    assert.equal(pkg.id, reordered.id);
    sandbox = await client.sandboxes.create({ packages: [pkg] });
    await assert.rejects(() => sandbox.command(pkg).run(), { code: "PACKAGE_HAS_NO_ENTRYPOINT" });
    assert.equal((await sandbox.command("alias").run()).text(), "original");
    const selected = await client.packages.create({ ...input, entrypoint: "alias" });
    assert.notEqual(pkg.id, selected.id);
    await sandbox.installPackage(selected);
    assert.equal((await sandbox.command(selected).run()).text(), "original");
    await assert.rejects(() => sandbox.command("hello").run(), { code: "COMMAND_AMBIGUOUS" });
    const different = await client.packages.create({ ...input, files: { "/data/input.txt": "different" } });
    assert.notEqual(pkg.id, different.id);
  } finally {
    await sandbox?.close();
    await client.close();
  }
});

test("creation reports invalid definitions and closed clients", async () => {
  const client = new Wasmer({ cache: false });
  try {
    for (const input of [
      { ...definition(), commands: { hello: { module: "missing" } } },
      { ...definition(), entrypoint: "missing" },
      { ...definition(), files: { "/../escape": "x" } },
      { ...definition(), files: { "/a": "x", "/a/b": "y" } },
    ]) {
      await assert.rejects(() => client.packages.create(input), { code: "INVALID_ARGUMENT" });
    }
    for (const bytes of [new Uint8Array(), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])]) {
      await assert.rejects(() => client.packages.create(definition(bytes)), { code: "PACKAGE_LOAD_FAILED" });
    }
  } finally {
    await client.close();
  }
  await assert.rejects(() => client.packages.create(definition()), { code: "CLIENT_CLOSED" });
});
