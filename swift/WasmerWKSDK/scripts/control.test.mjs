import assert from 'node:assert/strict';
import test from 'node:test';

test('cancellation releases process and sandbox results already queued by the worker', async () => {
  const saved = { window: globalThis.window, Worker: globalThis.Worker, crossOriginIsolated: globalThis.crossOriginIsolated };
  let worker;
  class Worker {
    messages = [];
    constructor(url) { worker = this; this.url = url; }
    postMessage(message) { this.messages.push(message); }
    terminate() {}
  }
  globalThis.window = { webkit: { messageHandlers: { wasmer: { postMessage: async () => true } } } };
  globalThis.Worker = Worker;
  globalThis.crossOriginIsolated = true;
  try {
    await import('../Sources/WasmerWKSDK/Web/control.js');
    const rpc = globalThis.wasmerRPC;
    for (const [method, value, cleanup, args] of [
      ['command.spawn', { handle: 7, id: 1 }, 'process.release', { process: 7 }],
      ['sandbox.create', 8, 'sandbox.close', { sandbox: 8 }],
      ['tcp.connect', 10, 'tcp.close', { connection: 10 }],
    ]) {
      const result = rpc.request({ id: method, method, args: {} });
      rpc.cancel(method);
      assert.equal((await result).error.code, 'CANCELLED');
      await worker.onmessage({ data: { id: method, value } });
      assert.equal(worker.messages.at(-1).method, cleanup);
      assert.deepEqual(worker.messages.at(-1).args, args);
    }
    const normal = rpc.request({ id: 'normal', method: 'command.spawn', args: {} });
    await worker.onmessage({ data: { id: 'normal', value: { handle: 9, id: 2 } } });
    assert.equal((await normal).value.handle, 9);
    const stopped = rpc.stop();
    assert.equal(worker.messages.at(-1).kind, 'storage-close');
    await worker.onmessage({data: {id: worker.messages.at(-1).id, value: true}});
    await stopped;
  } finally { Object.assign(globalThis, saved); delete globalThis.wasmerRPC; }
});
