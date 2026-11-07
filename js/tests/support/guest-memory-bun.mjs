// Bun smoke test: run with `bun tests/support/guest-memory-bun.mjs <cache>`.
// Pool workers find Bun.gc() and keep working when they collect after every
// guest. (Bun runs them as its own Web Workers, not through the Node adapter.)
import assert from "node:assert/strict";

import { Wasmer } from "../../dist/node.js";
import { obtainGarbageCollector } from "../../dist/node-garbage-collector.js";

let calls = 0;
const bunGc = Bun.gc;
Bun.gc = (force) => {
  calls += 1;
  return bunGc(force);
};
const collect = obtainGarbageCollector();
assert.equal(typeof collect, "function");
collect();
assert.equal(calls, 1, "the collector does not use Bun.gc()");
Bun.gc = bunGc;

const client = new Wasmer({
  cache: { directory: process.argv[2] },
  guestMemoryGcBudget: 1,
});
try {
  const hello = await client.packages.load("wasmer/hello-world@0.2.5");
  for (let index = 0; index < 3; index++) {
    const sandbox = await client.sandboxes.create({ packages: [hello] });
    try {
      const output = await sandbox.command("hello").run();
      assert.match(output.text(), /Hello from Wasmer/);
    } finally {
      await sandbox.close();
    }
  }
} finally {
  await client.close();
}
console.log("bun guest memory ok");
process.exit(0);
