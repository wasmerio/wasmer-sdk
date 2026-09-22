import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("pending worker tasks release transport envelopes and still report failures", async () => {
  await promisify(execFile)(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./support/worker-message-lifetime.mjs", import.meta.url)),
  ], { timeout: 10_000 });
});

test("dedicated workers release their SDK stack only after the guest completes", async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./support/worker-retirement.mjs", import.meta.url)),
  ], { timeout: 10_000 });
});
