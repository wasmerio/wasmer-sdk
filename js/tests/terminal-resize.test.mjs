import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Wasmer } from "../dist/node.js";

const edgejs = process.env.WASMER_EDGEJS_WEBC
  ? new Uint8Array(await readFile(process.env.WASMER_EDGEJS_WEBC))
  : "wasmer/edgejs@=0.2.4";
const cacheDirectory = fileURLToPath(new URL("../../.wasmer", import.meta.url));
const source = `
let signals = 0, resizes = 0;
process.stdin.setRawMode(true);
function report(label) {
  console.log(JSON.stringify({ label, columns: process.stdout.columns,
    rows: process.stdout.rows, signals, resizes }));
}
process.on('SIGWINCH', () => { signals++; setImmediate(() => report('resize')); });
process.stdout.on('resize', () => resizes++);
process.stdin.on('data', bytes => {
  for (const key of bytes.toString()) {
    if (key === 'g') report('read');
    if (key === 'q') process.exit(0);
  }
});
report('ready');
`;

for (const [name, command, args, input] of [
  ["direct process", "node", ["resize.cjs"]],
  ["exec replacement", "bash", ["-c", "exec node resize.cjs"]],
  ["foreground child", "bash", ["-c", "node resize.cjs; exit $?"]],
  ["interactive shell child", "bash", ["--noprofile", "--norc", "-i"], "node resize.cjs; exit\r"],
]) {
  test(`terminal resize notifies ${name}`, { timeout: 90_000 }, async () => {
    const client = new Wasmer({ cache: { directory: cacheDirectory } });
    let sandbox;
    try {
      sandbox = await client.sandboxes.create({ packages: [edgejs], files: { "resize.cjs": source } });
      const child = await sandbox.command(command, args).spawn({
        terminal: { columns: 100, rows: 35 }, stderr: "capture", timeoutMs: 20_000,
      });
      const reports = [];
      const drain = (async () => {
        for await (const line of child.stdout.lines()) {
          if (line.startsWith("{")) reports.push(JSON.parse(line));
        }
      })();
      async function waitForReport(label, after = 0) {
        const deadline = Date.now() + 5_000;
        while (!reports.slice(after).some(report => report.label === label)) {
          assert(Date.now() < deadline, `Missing ${label}: ${JSON.stringify(reports)}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return reports.slice(after).find(report => report.label === label);
      }
      if (input) await child.stdin.write(input);
      await waitForReport("ready");
      await child.resizeTerminal(45, 25);
      assert.deepEqual(await waitForReport("resize"), {
        label: "resize", columns: 45, rows: 25, signals: 1, resizes: 1,
      });
      // Repeated layout measurements must not produce extra signals.
      await child.resizeTerminal(45, 25);
      const start = reports.length;
      await child.stdin.write("g");
      assert.deepEqual(await waitForReport("read", start), {
        label: "read", columns: 45, rows: 25, signals: 1, resizes: 1,
      });
      await child.stdin.write("q");
      const output = await child.wait();
      await drain;
      assert.equal(output.exitCode, 0, output.stderr.text());
    } finally {
      await sandbox?.close();
      await client.close();
    }
  });
}
