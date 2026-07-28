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
  { skip: !packagePath, timeout: 60_000 },
  async () => {
    const port = await reservePort();
    const packageBytes = await readFile(packagePath);
    const client = new Wasmer({ outputBytes: 256 * 1024 });
    const postgres = await client.loadPackage(packageBytes);
    const sandbox = await client.createSandbox({
      packages: [postgres],
      network: true,
    });
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
        {
          cwd: "/",
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
          outputBytes: 256 * 1024,
        },
      )
      .spawn();

    const marker = `OLIPHAUNT_WASIX_SOCKET_READY ${port}`;
    const stderr = [];
    let signalReady;
    const ready = new Promise((resolve) => {
      signalReady = resolve;
    });
    const consumeStderr = (async () => {
      for await (const line of process.stderr.lines()) {
        stderr.push(line);
        if (line === marker) signalReady();
      }
    })();
    const consumeStdout = collectText(process.stdout);

    try {
      await Promise.race([
        ready,
        rejectAfter(30_000, "PostgreSQL did not open its WASIX TCP socket"),
      ]);
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
        { timeout: 20_000 },
      );
      assert.match(result.stdout, /wasm32-unknown-wasix.*\|42/m);
      const output = await process.wait({ check: true });
      assert.equal(output.code, 0);
    } catch (error) {
      await process.kill();
      throw new Error(`${error}\nPostgreSQL stderr:\n${stderr.join("\n")}`);
    } finally {
      await Promise.allSettled([consumeStderr, consumeStdout]);
      await sandbox.close();
      await client.shutdown();
    }
  },
);

async function collectText(stream) {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  return output + decoder.decode();
}

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

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}
