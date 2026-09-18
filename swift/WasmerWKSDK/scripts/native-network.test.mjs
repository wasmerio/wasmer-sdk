import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeNetworkBridge, respondToNetworkRequest } from '../Sources/WasmerWKSDK/Web/native-network.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const descriptor = { id: 7, local: '127.0.0.1:1234', peer: '127.0.0.1:5678' };

test('bounded native reads preserve binary data, EOF and readiness', async () => {
  let reads = 0;
  const bytes = Uint8Array.from({ length: 65536 }, (_, i) => i % 256);
  const bridge = new NativeNetworkBridge(async (method) => {
    if (method === 'connectTcp') return descriptor;
    if (method === 'socketRead') return ++reads <= 17 ? Buffer.from(bytes).toString('base64') : null;
    return true;
  });
  const events = [];
  bridge.setWakeCallback((id, event) => { events.push([id, event]); return true; });
  await bridge.connectTcp('0.0.0.0:0', descriptor.peer);
  await tick();
  assert.equal(reads, 16);
  assert.equal(bridge.socketReadable(7), 1024 * 1024);
  assert.deepEqual(bridge.socketRead(7, 65536), bytes);
  await tick();
  assert.equal(reads, 17);
  assert.deepEqual(bridge.socketRead(7, 65536), bytes);
  await tick(); // Native EOF arrives while 15 chunks remain buffered.
  bridge.socketRefresh(7);
  await tick();
  assert.ok(!events.some(([, event]) => event === 'close'));
  for (let i = 0; i < 15; i++) assert.deepEqual(bridge.socketRead(7, 65536), bytes);
  await tick();
  assert.equal(bridge.socketRead(7, 1), null);
  assert.ok(events.some(([, event]) => event === 'close'));
  bridge.close();
});

test('writes apply backpressure and preserve partial native sends', async () => {
  const sends = [];
  const bridge = new NativeNetworkBridge((method, args) => {
    if (method === 'connectTcp') return Promise.resolve(descriptor);
    if (method === 'socketRead') return new Promise(() => {});
    if (method === 'socketWrite') return new Promise(resolve => sends.push({ bytes: Buffer.from(args[1], 'base64'), resolve }));
    return Promise.resolve(true);
  });
  await bridge.connectTcp('0.0.0.0:0', descriptor.peer);
  const bytes = new Uint8Array(65536).fill(42);
  for (let i = 0; i < 4; i++) assert.equal(bridge.socketWrite(7, bytes), 65536);
  assert.equal(bridge.socketWrite(7, bytes), -1);
  assert.equal(bridge.socketWritable(7), -1);
  assert.equal(bridge.socketFlush(7), false);
  assert.equal(sends.length, 1);
  sends.shift().resolve(1024);
  await tick();
  assert.equal(bridge.socketWritable(7), 1024);
  assert.equal(sends[0].bytes.length, 65536 - 1024);
  let received = 1024;
  while (sends.length) {
    const send = sends.shift();
    assert.ok(send.bytes.every(byte => byte === 42));
    received += send.bytes.length; send.resolve(send.bytes.length);
    await tick();
  }
  assert.equal(received, 4 * 65536);
  assert.equal(bridge.socketFlush(7), true);
  bridge.close();
});

test('RPC reports DNS errors and binary/would-block/EOF without hanging a worker', async () => {
  const bridge = new NativeNetworkBridge(async () => { throw new Error('ENOTFOUND: missing.invalid'); });
  const request = { bridgeId: bridge.id, method: 'resolve', args: ['missing.invalid'], response: new SharedArrayBuffer(528) };
  await respondToNetworkRequest(bridge, request);
  const control = new Int32Array(request.response, 0, 4);
  assert.equal(control[0], 1); assert.equal(control[1], 5);
  assert.match(new TextDecoder().decode(new Uint8Array(request.response, 16, control[2])), /ENOTFOUND/);
  for (const [result, kind] of [[undefined, 3], [null, 4], [Uint8Array.of(0, 255), 2]]) {
    bridge.socketRead = () => result;
    request.method = 'socketRead'; request.args = [1, 2];
    await respondToNetworkRequest(bridge, request);
    assert.equal(control[1], kind);
  }
  request.method = 'constructor';
  await respondToNetworkRequest(bridge, request);
  assert.equal(control[1], 5);
  bridge.close();
});

test('separate sandbox bridges route independently and close only their own requests', async () => {
  const { installNativeNetworkGlobals, receiveNativeNetworkReply } = await import('../Sources/WasmerWKSDK/Web/native-network.js');
  const original = globalThis.postMessage;
  const messages = [];
  globalThis.postMessage = message => messages.push(message);
  const a = new NativeNetworkBridge(), b = new NativeNetworkBridge();
  try {
    installNativeNetworkGlobals(a); installNativeNetworkGlobals(b);
    assert.notEqual(a.id, b.id);
    const first = globalThis.__wasmerHostResolve(a.id, 'first.test');
    const second = globalThis.__wasmerHostResolve(b.id, 'second.test');
    const rejected = assert.rejects(first, /closed/);
    a.close(); await rejected;
    receiveNativeNetworkReply({ kind: 'networkResult', id: messages[1].id, value: ['127.0.0.2'] });
    assert.deepEqual(await second, ['127.0.0.2']);
    assert.throws(() => globalThis.__wasmerHostResolve(a.id, 'first.test'), /unknown/);
  } finally { a.close(); b.close(); globalThis.postMessage = original; }
});
