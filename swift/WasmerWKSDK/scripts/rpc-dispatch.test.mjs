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
