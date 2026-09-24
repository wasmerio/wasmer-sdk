import assert from 'node:assert/strict';
import test from 'node:test';
import { SDKDispatcher, encode, decode } from '../Sources/WasmerWKSDK/Web/rpc-dispatch.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const processes = [], sandboxes = [];
  const pkg = { id: 'sha256:fixture', commands: ['main'], entrypoint: 'main' };
  const core = {
    async loadPackage() { return pkg; },
    sandbox() {
      return { __wbg_ptr: 0, package() {}, file() {}, env() {}, network() {}, networkWisp() {},
        async start() {
          const sandbox = { isHttpPortListening(port) { return port === 8000; }, httpListeningPorts() { return Uint16Array.of(8000); }, freeCount: 0, async close() {}, free() { this.freeCount++; }, command() {
            const command = { __wbg_ptr: 0, args() {}, env() {}, currentDir() {}, stdinMode() {}, stdoutMode() {}, stderrMode() {},
              async spawn() {
                let finish;
                const done = new Promise(resolve => { finish = resolve; });
                const process = { id: processes.length + 1, killed: false, freed: false,
                  async wait() { await done; return { exitCode: 0, reason: 'exited', stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false, free() {} }; },
                  kill() { this.killed = true; finish(); }, free() { this.freed = true; },
                };
                processes.push(process); return process;
              } };
            return command;
          } };
          sandboxes.push(sandbox); return sandbox;
        } };
    } };
  const dispatcher = new SDKDispatcher(async () => core, () => ({ close() {} }));
  let id = 0;
  const request = (method, args = {}) => dispatcher.request(String(++id), method, args);
  return { dispatcher, request, processes, sandboxes };
}

test('byte encoding roundtrips large binary payloads', () => {
  const bytes = Uint8Array.from({ length: 131073 }, (_, i) => i % 256);
  assert.deepEqual(decode(encode(bytes)), bytes);
});
test('package wire metadata uses SDK getters and rejects unknown operations', async () => {
  const { request } = fixture();
  await request('initialize');
  assert.deepEqual(await request('package.load', { source: 'test' }), { handle: 1, id: 'sha256:fixture', commands: ['main'], entrypoint: 'main' });
  await assert.rejects(request('constructor'), { code: 'INVALID_ARGUMENT' });
});
test('cancelling one capture preserves other jobs and frees its process', async () => {
  const { request, dispatcher, processes } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'disabled' });
  const args = { sandbox, selector: { kind: 'name', name: 'main' } };
  const first = dispatcher.request('first', 'command.run', args);
  const second = dispatcher.request('second', 'command.run', args);
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  await tick();
  dispatcher.cancel('first'); await rejected;
  assert.ok(processes[0].killed && processes[0].freed);
  assert.equal(processes[1].killed, false);
  processes[1].kill(); await second;
  assert.ok(processes[1].freed);
});
test('sandbox close waits for async borrows; released process handles are freed', async () => {
  const { request, processes, sandboxes } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'disabled' });
  const spawned = await request('command.spawn', { sandbox, selector: { kind: 'name', name: 'main' }, stdin: 'closed', stdout: 'capture', stderr: 'capture' });
  const waiting = request('process.wait', { process: spawned.handle });
  await tick();
  await request('sandbox.close', { sandbox }); await waiting;
  assert.equal(sandboxes[0].freeCount, 1);
  await request('sandbox.close', { sandbox });
  await request('process.release', { process: spawned.handle });
  assert.ok(processes[0].freed);
  await assert.rejects(request('command.run', { sandbox, selector: { kind: 'name', name: 'main' } }), { code: 'SANDBOX_CLOSED' });
});

test('port discovery converts typed arrays and readiness observes guest ingress', async () => {
  const { request } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'host' });
  assert.deepEqual(await request('ports.list', { sandbox }), [8000]);
  assert.equal(await request('ports.wait', { sandbox, port: 8000, timeoutMs: 100 }), true);
  await assert.rejects(request('ports.wait', { sandbox, port: 1234, timeoutMs: 1 }), { code: 'TIMEOUT' });
  await assert.rejects(request('ports.wait', { sandbox, port: 0, timeoutMs: 100 }), { code: 'INVALID_ARGUMENT' });
  const disabled = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'disabled' });
  await assert.rejects(request('ports.wait', { sandbox: disabled, port: 8000, timeoutMs: 100 }), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('cancelled spawn releases the handle that Swift never received', async () => {
  const { request, dispatcher, processes } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'disabled' });
  const spawning = dispatcher.request('spawn', 'command.spawn', { sandbox, selector: { kind: 'name', name: 'main' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  dispatcher.cancel('spawn');
  await assert.rejects(spawning, { code: 'CANCELLED' });
  assert.equal(processes.length, 1);
  assert.ok(processes[0].killed && processes[0].freed);
});

test('workspace storage selects host provider and closes OPFS on success and creation failure', async () => {
  const selected = [], opened = [], closed = [];
  let fail = false;
  const storage = { async open(name) { opened.push(name); return 0x80000001; }, async close(id) { closed.push(id); } };
  const core = { sandbox() { return {
    network() {}, storageHost(id) { selected.push(id); }, mountHost() { assert.fail('workspace must not be an ordinary mount'); },
    async start() { if (fail) throw new Error('start failed'); return { async close() {}, free() {} }; },
  }; } };
  const dispatcher = new SDKDispatcher(async () => core, undefined, storage);
  const call = (method,args) => dispatcher.request(crypto.randomUUID(),method,args);
  await call('initialize',{});
  const base = {packages:[],files:{},env:{},network:'disabled'};
  const sandbox = await call('sandbox.create',{...base,storage:{kind:'opfs',volume:'trial'}});
  assert.deepEqual(opened,['trial']); assert.deepEqual(selected,[0x80000001]);
  await call('sandbox.close',{sandbox}); assert.deepEqual(closed,[0x80000001]);
  fail = true;
  await assert.rejects(call('sandbox.create',{...base,storage:{kind:'opfs',volume:'trial'}}), /start failed/);
  assert.equal(closed.length,2);
  fail = false;
  const memory = await call('sandbox.create',{...base,storage:{kind:'memory'}});
  assert.deepEqual(opened,['trial','trial']);
  assert.deepEqual(selected,[0x80000001,0x80000001]);
  await call('sandbox.close',{sandbox:memory});
  assert.equal(closed.length,2);
  await call('sandbox.create',{...base,storage:{kind:'native'},mounts:[{path:'/workspace',id:42,readOnly:false}]});
  assert.equal(selected.at(-1),42);
});

test('memory workspace works without an external storage worker', async () => {
  const { request } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', {
    packages: [], files: {}, env: {}, network: 'disabled', storage: {kind:'memory'},
  });
  await request('sandbox.close', {sandbox});
});

test('TCP close wakes pending reads and defers free until the borrow ends', async () => {
  const { request, dispatcher, sandboxes } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'host' });
  const events = [];
  let resolveRead;
  sandboxes[0].connectTcp = () => ({
    async read() { events.push('read'); return new Promise(resolve => { resolveRead = resolve; }); },
    async write(bytes) { events.push([...bytes]); },
    close() { events.push('close'); resolveRead?.(new Uint8Array()); },
    free() { events.push('free'); },
  });
  const connection = await request('tcp.connect', { sandbox, port: 5432 });
  await request('tcp.write', { connection, bytes: encode(Uint8Array.of(0, 255, 128)) });
  const reading = dispatcher.request('read', 'tcp.read', { connection });
  await tick();
  await request('sandbox.close', { sandbox });
  assert.equal(await reading, '');
  assert.deepEqual(events, [[0, 255, 128], 'read', 'close', 'free']);
  await request('tcp.close', { connection });
  await assert.rejects(request('tcp.read', { connection }), { code: 'CONNECTION_CLOSED' });
});

test('cancelling TCP reads or connects closes their otherwise unowned stream', async () => {
  const { request, dispatcher, sandboxes } = fixture();
  await request('initialize');
  const sandbox = await request('sandbox.create', { packages: [], files: {}, env: {}, network: 'host' });
  let closed = 0, freed = 0, resolveRead;
  sandboxes[0].connectTcp = () => ({
    read() { return new Promise(resolve => { resolveRead = resolve; }); },
    close() { closed++; resolveRead?.(new Uint8Array()); },
    free() { freed++; },
  });
  const connection = await request('tcp.connect', { sandbox, port: 5432 });
  const reading = dispatcher.request('read', 'tcp.read', { connection });
  await tick();
  const rejected = assert.rejects(reading, { code: 'CANCELLED' });
  dispatcher.cancel('read');
  await rejected;
  const connecting = dispatcher.request('connect', 'tcp.connect', { sandbox, port: 5432 });
  dispatcher.cancel('connect');
  await assert.rejects(connecting, { code: 'CANCELLED' });
  assert.equal(closed, 2);
  assert.equal(freed, 2);
});
