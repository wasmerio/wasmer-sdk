import assert from "node:assert/strict";
import test from "node:test";
import { probeJSPI } from "../Sources/WasmerWebKit/Web/jspi.js";

test("JSPI probe suspends a real Wasm import and resumes with its result", async () => {
  assert.deepEqual(await probeJSPI(), { jspi: true });
});

test("missing JSPI reports an actionable compatibility failure", async () => {
  const result = await probeJSPI({});
  assert.equal(result.jspi, false);
  assert.match(result.jspiError, /iOS 27/);
});

test("API presence alone cannot pass the JSPI probe", async () => {
  const broken = new Proxy(WebAssembly, {
    get(target, property) {
      if (property === "promising") return () => async () => 42;
      return Reflect.get(target, property);
    },
  });
  const result = await probeJSPI(broken);
  assert.equal(result.jspi, false);
  assert.match(result.jspiError, /suspend\/resume probe failed/);
});
