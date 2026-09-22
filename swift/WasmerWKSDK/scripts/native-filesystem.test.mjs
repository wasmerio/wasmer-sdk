import assert from "node:assert/strict";
import test from "node:test";
import { callNativeFileSystem } from "../Sources/WasmerWKSDK/Web/native-filesystem.js";

test("WebKit filesystem transfers full binary chunks and retains offsets", async () => {
  const bytes = Uint8Array.from({ length: 65536 }, (_, index) => index % 256);
  const encoded = Buffer.from(bytes).toString("base64");
  const request = { mount: 7, method: "write", args: [12, 123456, Array.from(bytes)] };
  const written = await callNativeFileSystem(request, async message => {
    assert.deepEqual(message, { kind: "filesystem", mount: 7, method: "writeBytes", args: [12, 123456, encoded] });
    return { value: bytes.length };
  });
  assert.equal(written.value, bytes.length);
  const read = await callNativeFileSystem({ mount: 7, method: "read", args: [12, 123456, 65536] }, async message => {
    assert.deepEqual(message, { kind: "filesystem", mount: 7, method: "readBytes", args: [12, 123456, 65536] });
    return { value: encoded };
  });
  assert.deepEqual(read.value, bytes);
  const eof = await callNativeFileSystem({ mount: 7, method: "read", args: [12, 999999, 65536] }, async () => ({ value: "" }));
  assert.deepEqual(eof.value, new Uint8Array());
});

test("filesystem metadata and native errors pass through unchanged", async () => {
  const error = { error: { code: "ENOENT", message: "Missing file" } };
  assert.equal(await callNativeFileSystem({ mount: 1, method: "read", args: [1, 0, 1] }, async () => error), error);
  const value = { value: { kind: "file", size: 12 } };
  assert.equal(await callNativeFileSystem({ mount: 1, method: "stat", args: ["file"] }, async message => {
    assert.deepEqual(message, { kind: "filesystem", mount: 1, method: "stat", args: ["file"] });
    return value;
  }), value);
});

test("base64 fallback preserves bytes on hosts without typed-array codecs", async () => {
  const toBase64 = Uint8Array.prototype.toBase64;
  const fromBase64 = Uint8Array.fromBase64;
  try {
    Uint8Array.prototype.toBase64 = undefined;
    Uint8Array.fromBase64 = undefined;
    const bytes = Uint8Array.from({ length: 65536 }, (_, index) => index % 256);
    let encoded;
    await callNativeFileSystem({ mount: 1, method: "write", args: [1, 0, bytes] }, async message => {
      encoded = message.args[2];
      return { value: bytes.length };
    });
    const result = await callNativeFileSystem({ mount: 1, method: "read", args: [1, 0, bytes.length] }, async () => ({ value: encoded }));
    assert.deepEqual(result.value, bytes);
  } finally {
    Uint8Array.prototype.toBase64 = toBase64;
    Uint8Array.fromBase64 = fromBase64;
  }
});
