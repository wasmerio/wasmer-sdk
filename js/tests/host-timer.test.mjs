import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../bindgen/src/tasks/timer.rs", import.meta.url),
  "utf8",
);
const inlineJs = source.match(/inline_js = r#"([\s\S]*?)"#/)[1];

function timers() {
  const pending = new Map();
  let nextId = 1;
  const host = {
    Promise,
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      pending.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const start = runInNewContext(
    `${inlineJs.replace("export function", "function")}\nwasmer_sdk_start_timer;`,
    { globalThis: host },
  );
  return { host, pending, start };
}

test("cancelling a host timer clears the timeout and settles its Promise", async () => {
  const { pending, start } = timers();
  const [promise, cancel] = start(60_000);
  assert.equal(pending.size, 1);
  assert.equal([...pending.values()][0].milliseconds, 60_000);
  let settled = false;
  promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  cancel();
  assert.equal(pending.size, 0);
  await Promise.resolve();
  assert.equal(settled, true);
  // Dropping an already completed Rust timer is harmless.
  cancel();
  assert.equal(pending.size, 0);
});

test("host timers keep their scheduling functions when globals are replaced", async () => {
  const { host, pending, start } = timers();
  const fail = () => { throw new Error("replacement scheduling function used"); };
  host.setTimeout = fail;
  host.clearTimeout = fail;
  host.Promise = fail;
  const [promise, cancel] = start(1);
  assert.equal(pending.size, 1);
  [...pending.values()][0].callback();
  await promise;
  cancel();
  assert.equal(pending.size, 0);
});
