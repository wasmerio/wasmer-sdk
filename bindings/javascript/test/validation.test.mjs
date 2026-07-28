import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import initCore, {
  WasmerCore,
} from "../pkg/wasmer_sdk_js.js";
import {
  Command,
  Ports,
  Process,
  Wasmer,
  WasmerError,
} from "../dist/index.js";

const UINT32_MAX = 0xffff_ffff;

test("wasm facade rejects invalid retention values from direct callers", async () => {
  const wasm = await readFile(
    new URL("../pkg/wasmer_sdk_js_bg.wasm", import.meta.url),
  );
  await initCore({ module_or_path: wasm });

  for (const value of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    UINT32_MAX + 1,
  ]) {
    assert.throws(
      () => WasmerCore.create({ outputBytes: value }),
      (error) => error?.code === "INVALID_ARGUMENT",
    );
  }

  const client = WasmerCore.create({});
  const sandbox = await client.sandbox().start();
  try {
    await assert.rejects(
      sandbox.waitForPort(-1, 100),
      (error) => error?.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      sandbox.waitForPort(8_080, Number.NaN),
      (error) => error?.code === "INVALID_ARGUMENT",
    );

    const command = sandbox.command("unresolved-command");
    assert.throws(
      () => command.timeoutMs(-1),
      (error) => error?.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => command.outputBytes(1.5),
      (error) => error?.code === "INVALID_ARGUMENT",
    );
  } finally {
    await sandbox.close();
    await client.shutdown();
  }
});

test("client output retention rejects unsafe JavaScript numbers", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new Wasmer({ outputBytes: value }),
      isInvalidArgument,
    );
  }
  assert.throws(
    () => new Wasmer({ outputBytes: UINT32_MAX + 1 }),
    isInvalidArgument,
  );
  assert.doesNotThrow(() => new Wasmer({ outputBytes: UINT32_MAX }));
});

test("command options are validated before constructing the wasm command", async () => {
  let builds = 0;
  const command = new Command(() => {
    builds += 1;
    throw new Error("the wasm command should not be constructed");
  });

  await assert.rejects(command.run({ timeoutMs: -1 }), isInvalidArgument);
  await assert.rejects(command.run({ timeoutMs: 0.25 }), isInvalidArgument);
  await assert.rejects(
    command.spawn({ timeoutMs: Number.POSITIVE_INFINITY }),
    isInvalidArgument,
  );
  await assert.rejects(
    command.spawn({ timeoutMs: Number.MAX_SAFE_INTEGER + 1 }),
    isInvalidArgument,
  );
  await assert.rejects(
    command.run({ outputBytes: UINT32_MAX + 1 }),
    isInvalidArgument,
  );
  assert.equal(builds, 0);
});

test("port and termination inputs enforce their public ranges", async () => {
  let portCalls = 0;
  const ports = new Ports({
    waitForPort() {
      portCalls += 1;
      return Promise.resolve();
    },
  });
  for (const port of [0, -1, 1.5, 65_536, Number.NaN]) {
    await assert.rejects(ports.wait(port), isInvalidArgument);
  }
  await assert.rejects(
    ports.wait(8_080, { timeoutMs: Number.NaN }),
    isInvalidArgument,
  );
  assert.equal(portCalls, 0);

  let terminateCalls = 0;
  const process = new Process(
    {
      terminate() {
        terminateCalls += 1;
        return Promise.resolve();
      },
    },
    { stdin: false, stdout: false, stderr: false },
  );
  await assert.rejects(
    process.terminate({ gracePeriodMs: -1 }),
    isInvalidArgument,
  );
  await assert.rejects(
    process.terminate({ gracePeriodMs: 1.5 }),
    isInvalidArgument,
  );
  assert.equal(terminateCalls, 0);
});

function isInvalidArgument(error) {
  assert(error instanceof WasmerError);
  assert.equal(error.code, "INVALID_ARGUMENT");
  return true;
}
