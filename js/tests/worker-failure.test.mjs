import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Wasmer } from "../dist/node.js";
import { nodeWorkerStats } from "../dist/node-worker-adapter.js";
import { setWorkerUrl } from "../pkg/wasmer_sdk_js.js";

for (const [name, source, message] of [
  ["exception", 'throw new Error("injected worker failure")', /injected worker failure/],
  ["unexpected exit", "process.exit(0)", /exited unexpectedly with status 0/],
]) {
  test(`propagates a worker ${name} to process completion and client shutdown`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const client = new Wasmer({
      cache: { directory: fileURLToPath(new URL("../../.wasmer", import.meta.url)) },
    });
    const pkg = await client.packages.load("wasmer/hello-world@0.2.5");
    const sandbox = await client.sandboxes.create({ packages: [pkg] });
    const failuresBefore = nodeWorkerStats().workerFailures;
    setWorkerUrl(`data:text/javascript,${encodeURIComponent(source)}`);
    try {
      const process = await sandbox.command("hello").spawn({ stdout: "discard", stderr: "discard" });
      // Start shutdown before the worker reports its failure: a draining
      // scheduler must not wait forever for the dead worker's idle message.
      const closed = assert.rejects(client.close(), (error) => {
        assert.equal(error.code, "WORKER_FAILED");
        assert.match(error.message, message);
        return true;
      });
      const output = await process.wait();
      assert.equal(output.exitCode, 1);
      await closed;
      assert.equal(nodeWorkerStats().workerFailures, failuresBefore + 1);
      assert.equal(log.mock.callCount(), 1, "error and exit must not report the failure twice");
    } finally {
      setWorkerUrl(new URL("../dist/node-worker.js", import.meta.url).href);
      await sandbox.close();
      await client.close().catch(() => {});
    }
  });
}
