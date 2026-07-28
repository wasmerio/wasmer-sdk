import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import { promisify } from "node:util";

import { Wasmer } from "../dist/node.js";

const execFileAsync = promisify(execFile);
const packagePath = process.env.WASMER_POSTGRES_WEBC;
const psql = process.env.PSQL ?? "/opt/homebrew/opt/libpq/bin/psql";

test(
  "connects native psql to PostgreSQL running inside WASIX",
  { skip: !packagePath, timeout: 30_000 },
  async () => {
    const port = await reservePort();
    const packageBytes = await readFile(packagePath);
    const client = new Wasmer({ outputBytes: 256 * 1024 });
    const postgres = await client.loadPackage(packageBytes);
    const sandbox = await client.createSandbox({
      packages: [postgres],
      network: { mode: "host" },
      env: {
        OLIPHAUNT_WASIX_SOCKET_PORT: String(port),
        PREFIX: "/",
        PGDATA: "/base",
        PGUSER: "postgres",
        PGDATABASE: "postgres",
        PGSYSCONFDIR: "/base",
        PGCLIENTENCODING: "UTF8",
        LC_CTYPE: "C.UTF-8",
        TZ: "UTC",
        PGTZ: "UTC",
        PG_COLOR: "never",
      },
    });
    // Capture mode retains bounded diagnostics without live readers, so the
    // guest never blocks and no stream-draining tasks are needed.
    const process = await sandbox
      .command(
        postgres,
        [
          "--single",
          "-F",
          "-O",
          "-j",
          "-c",
          "io_method=sync",
          "-D",
          "/base",
          "postgres",
        ],
        { cwd: "/" },
      )
      .spawn({ stdout: "capture", stderr: "capture", outputBytes: 256 * 1024 });

    try {
      await sandbox.ports.wait(port, { timeoutMs: 20_000 });
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

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
