import assert from "node:assert/strict";
import test from "node:test";

test("WebKit budget bounds shared memories while retaining Wasm import compatibility", async () => {
  const NativeMemory = WebAssembly.Memory;
  try {
    const { createRuntimeMemory } = await import("../Sources/WasmerWKSDK/Web/memory-budget.js");
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 32767, shared: true });
    assert.ok(memory instanceof NativeMemory);
    assert.ok(memory instanceof WebAssembly.Memory);
    assert.ok(structuredClone(memory).buffer instanceof SharedArrayBuffer);
    assert.equal(memory.grow(2048), 1);
    assert.throws(() => memory.grow(3072), RangeError);
    assert.throws(() => new WebAssembly.Memory({ initial: 3073, maximum: 32767, shared: true }), /192 MiB/);
    // (module (import "env" "memory" (memory 1 32767 shared)))
    const module = new WebAssembly.Module(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      2, 18, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121,
      2, 3, 1, 255, 255, 1,
    ]));
    assert.ok(new WebAssembly.Instance(module, { env: { memory } }));
    // The SDK heap can grow past the guest limit, without eagerly
    // allocating its full 1 GiB ceiling at startup.
    const runtime = createRuntimeMemory();
    assert.equal(runtime.buffer.byteLength, 25 * 65536);
    assert.equal(runtime.grow(8192), 25);
    assert.throws(() => runtime.grow(16384), RangeError);
  } finally {
    WebAssembly.Memory = NativeMemory;
  }
});
