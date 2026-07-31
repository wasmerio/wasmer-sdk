import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Wasmer } from "@wasmer/sdk2/node";

const execFileAsync = promisify(execFile);
const port = 5432;
const psql = process.env.PSQL ?? process.argv[2] ?? "psql";
const query = fileURLToPath(
  new URL("../../fixtures/postgres/query.sql", import.meta.url),
);

const client = new Wasmer({ outputBytes: 256 * 1024 });
const sandbox = await client.sandboxes.create({
  packages: ["wasmer/pglite@0.1.0"],
  network: { mode: "host" },
});
const postgres = await sandbox
  .command("pglite")
  .spawn({ stdout: "capture", stderr: "pipe" });

try {
  assert(postgres.stderr);
  await waitForLine(
    postgres.stderr.lines(),
    `OLIPHAUNT_WASIX_SOCKET_READY ${port}`,
    30_000,
  );

  const uri =
    `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  const result = await execFileAsync(
    psql,
    [uri, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-f", query],
    { timeout: 10_000 },
  );
  console.log(`Connected native psql to PostgreSQL running in Wasmer`);
  console.log(result.stdout.trim());

  await postgres.wait({ check: true });
} catch (error) {
  await postgres.kill();
  const output = await postgres.wait();
  throw new Error(`${error}\nPostgreSQL stderr:\n${output.stderr.text()}`);
} finally {
  await sandbox.close();
  await client.close();
}

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
