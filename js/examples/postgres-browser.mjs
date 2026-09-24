// Serve this repository's js/ directory with COOP/COEP headers (see README).
import { Wasmer } from "../dist/index.js";

/** Start PostgreSQL and the real WASIX psql client in separate sandboxes. */
export async function startPostgres({ onOutput = console.log, onProgress } = {}) {
  const wasmer = new Wasmer();
  let database, terminal;
  async function close() {
    await terminal?.close();
    await database?.close();
    await wasmer.close();
  }
  try {
    const [pg, psql] = await wasmer.packages.loadMany(
      ["wasmer/pglite@=0.1.3", "wasmer/psql@=18.4.0"],
      { onProgress },
    );
    database = await wasmer.sandboxes.create({
      packages: [pg], network: { mode: "http" },
    });
    const server = await database.command(pg).spawn({ stdout: "capture", stderr: "capture" });
    await database.ports.wait(5432);
    terminal = await wasmer.sandboxes.create({
      packages: [psql], network: { mode: "http" },
      // Restrict connections instead: network: { mode: "http", peers: [database] }
    });
    const process = await terminal.command(psql, ["-X", "-P", "pager=off"]).spawn({ stdin: "pipe" });
    const pump = async stream => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) onOutput(decoder.decode(bytes, { stream: true }));
      onOutput(decoder.decode());
    };
    const output = Promise.all([pump(process.stdout), pump(process.stderr)]);
    const done = process.wait().then(async result => { await output; return result; });
    return {
      database, terminal, server, done,
      async send(line) { await process.stdin.write(line + "\n"); },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
