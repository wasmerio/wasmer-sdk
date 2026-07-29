import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { Wasmer } from "../dist/node.js";

const execFileAsync = promisify(execFile);
const psql = process.env.PSQL ?? "psql";
const port = 5432;

test(
  "connects native psql to PostgreSQL running inside WASIX",
  { timeout: 90_000 },
  async () => {
    const client = new Wasmer({ outputBytes: 256 * 1024 });
    const pglite = await client.packages.load("wasmer/pglite@0.1.0");
    assert.equal(pglite.entrypoint, "pglite");
    assert(pglite.commands.includes("pglite"));
    const sandbox = await client.sandboxes.create({
      packages: [pglite],
      network: { mode: "host" },
    });
    const process = await sandbox
      .command(pglite)
      .spawn({ stdout: "capture", stderr: "pipe", outputBytes: 256 * 1024 });

    try {
      assert(process.stderr);
      await waitForLine(
        process.stderr.lines(),
        `OLIPHAUNT_WASIX_SOCKET_READY ${port}`,
        20_000,
      );
      const uri =
        `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
      const result = await execFileAsync(
        psql,
        [
          uri,
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-c",
          "select version(), 40 + 2 as answer;",
        ],
        { timeout: 10_000 },
      );
      assert.match(result.stdout, /wasm32-unknown-wasix.*\|42/m);
      const output = await process.wait({ check: true });
      assert.equal(output.exitCode, 0);
      assert.equal(output.reason, "exited");
    } catch (error) {
      await process.kill();
      const output = await process.wait();
      throw new Error(
        `${error}\nPostgreSQL stderr:\n${output.stderr.text()}`,
      );
    } finally {
      await sandbox.close();
      await client.close();
    }
  },
);

async function waitForLine(lines, marker, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      (async () => {
        for await (const line of lines) {
          if (line.includes(marker)) return;
        }
        throw new Error(`process exited before emitting ${marker}`);
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${marker}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
