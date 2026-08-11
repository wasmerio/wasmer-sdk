import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Wasmer } from "../dist/node.js";

const edgejsWebc = process.env.WASMER_EDGEJS_WEBC;
const edgejsPackage = process.env.WASMER_EDGEJS_PACKAGE;
const edgejsAvailable = Boolean(edgejsWebc || edgejsPackage);

test(
  "preserves literal addresses through Edge's lookup path",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "lookup.cjs": `
const dns = require('node:dns');
dns.lookup('127.0.0.1', { all: true }, (error, addresses) => {
  if (error) throw error;
  console.log('__LOOKUP__', JSON.stringify(addresses));
});
`,
        },
      });
      const output = await sandbox.command("node", ["/workspace/lookup.cjs"]).run({
        timeoutMs: 30_000,
        check: false,
      });
      assert.equal(output.ok, true, output.stderr.text());
      assert.match(output.stdout.text(), /__LOOKUP__ \[\{"address":"127\.0\.0\.1","family":4\}\]/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "runs edge and node aliases with the host-JavaScript N-API provider",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      assert.deepEqual(edgejs.commands, ["edge", "edgejs", "node", "npm", "pnpm"]);

      sandbox = await client.sandboxes.create({ packages: [edgejs] });
      for (const command of ["edge", "node"]) {
        const output = await sandbox.command(command, ["--version"]).run();
        assert.match(output.text(), /^v\d+\.\d+\.\d+(?:-[^\s]+)?\n$/);
      }
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "links and evaluates source-text ESM with the host-JavaScript N-API provider",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "dependency.mjs": `export const answer = await Promise.resolve(42);`,
          "entry.mjs": `
import { answer } from './dependency.mjs';
const config = { answer, url: import.meta.url };
export default config;
console.log('__ESM_SOURCE_TEXT_OK__', config.answer, config.url.endsWith('/entry.mjs'));
`,
          "load.cjs": `
import('./entry.mjs').catch((error) => {
  console.error('__ESM_SOURCE_TEXT_ERROR__', error && error.stack || error);
  process.exitCode = 1;
});
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/load.cjs"])
        .run({ timeoutMs: 30_000, check: false });
      assert.equal(
        output.ok,
        true,
        `exit=${output.exitCode} reason=${output.reason}\nstdout:\n${output.stdout.text()}\nstderr:\n${output.stderr.text()}`,
      );
      assert.match(output.stdout.text(), /__ESM_SOURCE_TEXT_OK__ 42 true/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "routes Edge queueMicrotask through the host microtask queue once",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "microtask.cjs": `
let completed = 0;
function step() {
  completed += 1;
  if (completed === 100) {
    console.log('__MICROTASK_OK__', completed);
    return;
  }
  queueMicrotask(step);
}
queueMicrotask(step);
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/microtask.cjs"])
        .run({ timeoutMs: 30_000, check: false });
      assert.equal(
        output.ok,
        true,
        `exit=${output.exitCode} reason=${output.reason}\nstdout:\n${output.stdout.text()}\nstderr:\n${output.stderr.text()}`,
      );
      assert.match(output.stdout.text(), /__MICROTASK_OK__ 100/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "routes worker messages only to the receiving host worker",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "worker.cjs": `
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (isMainThread) {
  const worker = new Worker(__filename);
  worker.once('message', (value) => {
    console.log('__WORKER_REPLY__', value.kind, value.bytes.join(','));
  });
  worker.postMessage({ kind: 'request', bytes: new Uint8Array([3, 1, 4]) });
} else {
  parentPort.once('message', (value) => {
    parentPort.postMessage({ kind: value.kind + '-reply', bytes: Array.from(value.bytes) });
  });
}
`,
        },
      });

      const process = await sandbox
        .command("node", ["/workspace/worker.cjs"])
        .spawn({ stdout: "pipe", stderr: "pipe" });
      const stdout = [];
      const stderr = [];
      const stdoutReader = collectLines(process.stdout, stdout);
      const stderrReader = collectLines(process.stderr, stderr);
      let output;
      try {
        output = await waitWithTimeout(process.wait(), 15_000, "worker round trip timed out");
      } catch (error) {
        await process.kill();
        await process.wait();
        await Promise.all([stdoutReader, stderrReader]);
        assert.fail(
          `${error.message}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`,
        );
      }
      await Promise.all([stdoutReader, stderrReader]);
      assert.equal(
        output.ok,
        true,
        `stdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`,
      );
      assert.match(stdout.join("\n"), /__WORKER_REPLY__ request-reply 3,1,4/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "can post a shutdown message to an idle persistent worker",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "worker-shutdown.cjs": `
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (isMainThread) {
  const worker = new Worker(__filename);
  worker.once('message', (value) => {
    if (value !== 'idle') throw new Error('unexpected worker response');
    setImmediate(() => worker.postMessage(false));
  });
  worker.once('exit', (code) => console.log('__WORKER_EXIT__', code));
  worker.postMessage({ kind: 'work' });
} else {
  const handle = (value) => {
    if (value === false) {
      parentPort.off('message', handle);
      process.exit(0);
    }
    parentPort.postMessage('idle');
  };
  parentPort.on('message', handle);
}
`,
        },
      });

      const process = await sandbox
        .command("node", ["/workspace/worker-shutdown.cjs"])
        .spawn({ stdout: "pipe", stderr: "pipe" });
      const stdout = [];
      const stderr = [];
      const stdoutReader = collectLines(process.stdout, stdout);
      const stderrReader = collectLines(process.stderr, stderr);
      let output;
      try {
        output = await waitWithTimeout(process.wait(), 15_000, "worker shutdown timed out");
      } finally {
        await Promise.allSettled([stdoutReader, stderrReader]);
      }

      assert.equal(
        output.ok,
        true,
        `stdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`,
      );
      assert.match(stdout.join("\n"), /__WORKER_EXIT__ 0/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "starts an Edge child process without IPC",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "spawn-child.cjs": `console.log('__SPAWN_CHILD_OK__');`,
          "spawn-parent.cjs": `
const { spawn } = require('node:child_process');
const child = spawn('/bin/node', ['/workspace/spawn-child.cjs'], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
child.on('exit', (code) => console.log('__SPAWN_PARENT_OK__', code));
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/spawn-parent.cjs"])
        .run({ timeoutMs: 30_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.match(output.stdout.text(), /__SPAWN_CHILD_OK__/);
      assert.match(output.stdout.text(), /__SPAWN_PARENT_OK__ 0/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "passes a high-numbered pipe to an Edge child process",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "fd-child.cjs": `
const fs = require('node:fs');
fs.writeSync(10, '__FD10_CHILD_OK__\\n');
`,
          "fd-parent.cjs": `
const { spawn } = require('node:child_process');
const stdio = ['inherit', 'inherit', 'inherit'];
while (stdio.length < 10) stdio.push('ignore');
stdio.push('pipe');
const child = spawn('/bin/node', ['/workspace/fd-child.cjs'], { stdio });
child.stdio[10].on('data', (data) => process.stdout.write(data));
child.on('exit', (code) => console.log('__FD10_PARENT_OK__', code));
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/fd-parent.cjs"])
        .run({ timeoutMs: 30_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.match(output.stdout.text(), /__FD10_CHILD_OK__/, output.stderr.text());
      assert.match(output.stdout.text(), /__FD10_PARENT_OK__ 0/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "completes child_process fork IPC",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 60_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "fork-child.cjs": `
process.send('ready');
process.on('message', (message) => {
  if (message === 'finish') process.exit(0);
});
`,
          "fork-parent.cjs": `
const { fork } = require('node:child_process');
const child = fork('/workspace/fork-child.cjs', [], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
child.on('message', (message) => {
  if (message === 'ready') child.send('finish');
});
child.on('exit', (code) => console.log('__FORK_IPC_OK__', code));
`,
        },
      });

      const process = await sandbox
        .command("node", ["/workspace/fork-parent.cjs"])
        .spawn({ stdout: "pipe", stderr: "pipe" });
      const stdout = [];
      const stderr = [];
      const stdoutReader = collectLines(process.stdout, stdout);
      const stderrReader = collectLines(process.stderr, stderr);
      let output;
      try {
        output = await waitWithTimeout(process.wait(), 15_000, "fork IPC timed out");
      } catch (error) {
        await process.kill();
        await process.wait();
        await Promise.all([stdoutReader, stderrReader]);
        assert.fail(`${error.message}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`);
      }
      await Promise.all([stdoutReader, stderrReader]);
      assert.equal(output.ok, true, `stdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`);
      assert.match(stdout.join("\n"), /__FORK_IPC_OK__ 0/);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "runs a referenced timer",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({ packages: [edgejs] });
      const output = await sandbox
        .command("node", ["-e", "setTimeout(() => console.log('__TIMER_OK__'), 50)"])
        .run({ timeoutMs: 10_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.match(output.stdout.text(), /__TIMER_OK__/, output.stderr.text());
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "preserves filesystem stat metadata across the host-N-API boundary",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({ packages: [edgejs] });
      const output = await sandbox
        .command("node", [
          "-e",
          `const fs = require('node:fs');
Promise.all([fs.promises.stat('.'), fs.promises.lstat('.')]).then(([stat, lstat]) => {
  console.log(JSON.stringify({
    cwd: process.cwd(),
    stat: stat.isDirectory(),
    statMode: stat.mode,
    lstat: lstat.isDirectory(),
    lstatMode: lstat.mode,
  }));
});`,
        ])
        .run({ timeoutMs: 10_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      const result = JSON.parse(output.stdout.text().trim());
      assert.equal(result.cwd, "/workspace");
      assert.equal(result.stat, true, `${JSON.stringify(result)}\n${output.stderr.text()}`);
      assert.equal(result.lstat, true, `${JSON.stringify(result)}\n${output.stderr.text()}`);
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "uses provider-owned buffers for unsafe allocation and stream ingress",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "stream-fixture.txt": "provider-owned-stream-data",
          "stream-buffer.cjs": `
const fs = require('node:fs');
const expected = Buffer.from('provider-owned-stream-data');
const unsafe = Buffer.allocUnsafe(64);
unsafe.fill(0xa5);

const chunks = [];
fs.createReadStream('/workspace/stream-fixture.txt', { highWaterMark: 5 })
  .on('data', (chunk) => chunks.push(chunk))
  .on('end', () => {
    const received = Buffer.concat(chunks);
    console.log(JSON.stringify({
      unsafeLength: unsafe.length,
      received: received.toString(),
      matches: received.equals(expected),
    }));
  });
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/stream-buffer.cjs"])
        .run({ timeoutMs: 10_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.deepEqual(JSON.parse(output.stdout.text().trim()), {
        unsafeLength: 64,
        received: "provider-owned-stream-data",
        matches: true,
      });
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "keeps retained host Buffer mirrors coherent across async file reads",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    const fixture = "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n";
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "fixture.txt": fixture,
          "read-buffers.cjs": `
const fs = require('node:fs');
const path = '/workspace/fixture.txt';
const sync = fs.readFileSync(path);

// Allocate unrelated host values between the two reads. A mirror must retain
// the Buffer itself, rather than a callback-scoped handle that can be reused.
for (let index = 0; index < 128; index++) Buffer.from('unrelated-' + index);

fs.promises.readFile(path).then((asyncValue) => {
  console.log(JSON.stringify({
    asyncMatches: asyncValue.equals(sync),
    length: sync.length,
  }));
});
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/read-buffers.cjs"])
        .run({ timeoutMs: 10_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      const result = JSON.parse(output.stdout.text().trim());
      assert.deepEqual(result, {
        asyncMatches: true,
        length: Buffer.byteLength(fixture),
      });
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "retains zlib byte ranges through sync continuations and async work",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "zlib-leases.cjs": `
const zlib = require('node:zlib');

const storage = Buffer.alloc(256 * 1024 + 64, 0xa5);
const input = storage.subarray(32, storage.length - 32);
for (let index = 0; index < input.length; index++) input[index] = index & 0xff;

const compressed = zlib.gzipSync(input);
const pooled = Buffer.alloc(compressed.length + 46, 0xcc);
compressed.copy(pooled, 23);
const compressedRange = pooled.subarray(23, 23 + compressed.length);

// A small output chunk forces processChunkSync() to continue with the same
// retained input lease many times.
const syncOutput = zlib.gunzipSync(compressedRange, { chunkSize: 1024 });

zlib.gzip(input, { chunkSize: 1024 }, (gzipError, asyncCompressed) => {
  if (gzipError) throw gzipError;
  zlib.gunzip(asyncCompressed, { chunkSize: 1024 }, (gunzipError, asyncOutput) => {
    if (gunzipError) throw gunzipError;
    console.log(JSON.stringify({
      syncMatches: syncOutput.equals(input),
      asyncMatches: asyncOutput.equals(input),
      prefixPreserved: storage[31] === 0xa5 && pooled[22] === 0xcc,
      suffixPreserved: storage[storage.length - 32] === 0xa5 &&
        pooled[23 + compressed.length] === 0xcc,
    }));
  });
});
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/zlib-leases.cjs"])
        .run({ timeoutMs: 15_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.deepEqual(JSON.parse(output.stdout.text().trim()), {
        syncMatches: true,
        asyncMatches: true,
        prefixPreserved: true,
        suffixPreserved: true,
      });
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

test(
  "preserves exact Buffer ranges across native filesystem access",
  {
    skip: edgejsAvailable ? false : "set WASMER_EDGEJS_WEBC or WASMER_EDGEJS_PACKAGE",
    timeout: 30_000,
  },
  async () => {
    const client = new Wasmer({ cache: false });
    let sandbox;
    try {
      await client.ready();
      const edgejs = await loadEdgejs(client);
      sandbox = await client.sandboxes.create({
        packages: [edgejs],
        files: {
          "buffer-ranges.cjs": `
const fs = require('node:fs');

(async () => {
  const source = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < source.length; index++) source[index] = index & 0xff;
  const sourceOffset = 131072;
  const targetOffset = 262144;
  const length = 65536;
  const path = '/workspace/ranged.bin';
  const handle = await fs.promises.open(path, 'w+');
  try {
    const written = await handle.write(source, sourceOffset, length, 0);
    const target = Buffer.alloc(1024 * 1024, 0xa5);
    const read = await handle.read(target, targetOffset, length, 0);

    const vectorPath = '/workspace/vectored.bin';
    const vectorHandle = await fs.promises.open(vectorPath, 'w+');
    const firstStorage = Buffer.from('x-first-y');
    const secondStorage = Buffer.from('x-second-y');
    const vectorWrite = await vectorHandle.writev([
      firstStorage.subarray(2, 7),
      secondStorage.subarray(2, 8),
    ], 0);
    await vectorHandle.close();

    const syncPath = '/workspace/sync-ranged.bin';
    const syncFd = fs.openSync(syncPath, 'w+');
    const syncSource = Buffer.from('x-sync-y');
    const syncWritten = fs.writeSync(syncFd, syncSource, 2, 4, 0);
    const syncTarget = Buffer.alloc(10, 0xa5);
    const syncRead = fs.readSync(syncFd, syncTarget, 3, 4, 0);
    fs.closeSync(syncFd);

    console.log(JSON.stringify({
      written: written.bytesWritten,
      read: read.bytesRead,
      rangeMatches: target.subarray(targetOffset, targetOffset + length)
        .equals(source.subarray(sourceOffset, sourceOffset + length)),
      prefixPreserved: target[targetOffset - 1] === 0xa5,
      suffixPreserved: target[targetOffset + length] === 0xa5,
      vectorWritten: vectorWrite.bytesWritten,
      vectorMatches: (await fs.promises.readFile(vectorPath)).equals(Buffer.from('firstsecond')),
      syncWritten,
      syncRead,
      syncMatches: syncTarget.subarray(3, 7).equals(Buffer.from('sync')),
      syncPrefixPreserved: syncTarget[2] === 0xa5,
      syncSuffixPreserved: syncTarget[7] === 0xa5,
    }));
  } finally {
    await handle.close();
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
`,
        },
      });

      const output = await sandbox
        .command("node", ["/workspace/buffer-ranges.cjs"])
        .run({ timeoutMs: 15_000, check: false });
      assert.equal(output.ok, true, output.stderr.text());
      assert.deepEqual(JSON.parse(output.stdout.text().trim()), {
        written: 65536,
        read: 65536,
        rangeMatches: true,
        prefixPreserved: true,
        suffixPreserved: true,
        vectorWritten: 11,
        vectorMatches: true,
        syncWritten: 4,
        syncRead: 4,
        syncMatches: true,
        syncPrefixPreserved: true,
        syncSuffixPreserved: true,
      });
    } finally {
      await sandbox?.close();
      await client.close();
    }
  },
);

async function collectLines(stream, target) {
  if (!stream) return;
  for await (const line of stream.lines()) target.push(line);
}

async function waitWithTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadEdgejs(client) {
  if (edgejsWebc) {
    return client.packages.load(new Uint8Array(await readFile(edgejsWebc)));
  }
  return client.packages.load(edgejsPackage);
}
