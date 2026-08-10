import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

const fixturePath = process.env.WASMER_NAPI_HOST_JS_WEBC;

test(
  "isolates N-API environments and preserves opaque buffer leases",
  {
    skip: fixturePath ? false : "set WASMER_NAPI_HOST_JS_WEBC",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const fixture = await client.packages.load(
        new Uint8Array(await readFile(fixturePath)),
      );
      sandbox = await client.sandboxes.create({ packages: [fixture] });
      const output = await sandbox.command("run-script-test", []).run({
        timeoutMs: 30_000,
        check: false,
      });
      assert.equal(
        output.ok,
        true,
        `exit=${output.exitCode} reason=${output.reason}\nstdout:\n${output.stdout.text()}\nstderr:\n${output.stderr.text()}`,
      );
      assert.equal(output.stdout.text(), "RUN_SCRIPT_TEST_OK=1\n");
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);
