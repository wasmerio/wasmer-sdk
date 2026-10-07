import assert from "node:assert/strict";
import test from "node:test";

import { Wasmer } from "../dist/node.js";
import init from "../pkg/wasmer_sdk_js.js";

test("closing clients releases their Rust network callback roots", async () => {
  // Initialize through the Node entry point, which loads the local Wasm bytes
  // and installs process-wide logging before measuring per-client roots.
  const warmup = new Wasmer({ cache: false });
  try {
    await warmup.ready();
  } finally {
    await warmup.close();
  }
  const wasm = await init();
  const functionRoots = () => {
    let count = 0;
    for (let index = 0; index < wasm.__wbindgen_externrefs.length; index++) {
      if (typeof wasm.__wbindgen_externrefs.get(index) === "function") count++;
    }
    return count;
  };
  const baseline = functionRoots();
  for (let index = 0; index < 20; index++) {
    const client = new Wasmer({ cache: false });
    try {
      await client.ready();
    } finally {
      await client.close();
    }
    assert.equal(functionRoots(), baseline, `callback retained after client ${index + 1}`);
  }
});
