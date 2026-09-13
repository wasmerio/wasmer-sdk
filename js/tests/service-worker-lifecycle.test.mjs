import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const workerCode = (await readFile(new URL('../dist/service-worker.js', import.meta.url), 'utf8')).replace('export {};', '');
const hostCode = (await readFile(new URL('../dist/service-worker-host.js', import.meta.url), 'utf8')).replace('export {};', '');

// Real MessageChannels, but a new global scope for every worker restart.
// No Wasmer runtime or browser idle timeout is needed to lose all worker state.
test('HTTP routes reconnect after service-worker state is discarded', {timeout: 15000}, async () => {
  const ports = [];
  class TrackedChannel extends MessageChannel {
    constructor() { super(); ports.push(this.port1, this.port2); }
  }
  const common = { URL, URLSearchParams, MessageChannel: TrackedChannel, Request, Response, Headers, Uint8Array, crypto, setTimeout, clearTimeout };
  const hostEvents = {};
  const hostWorkerEvents = {};
  let workerEvents;
  let recoveries = 0;
  const client = {
    url: 'http://host/.wasmer/host.html?parentOrigin=http://app',
    postMessage(data, ports) { recoveries++; hostWorkerEvents.message({data, ports}); },
  };
  const worker = {
    state: 'activated',
    postMessage(data, ports) { workerEvents.message({data, ports, waitUntil(p) { p.catch(assert.fail); }}); },
  };
  const restart = () => {
    workerEvents = {};
    vm.runInNewContext(workerCode, {...common,
      addEventListener(type, callback) { workerEvents[type] = callback; },
      clients: { matchAll: async () => [client], claim: async () => {} },
      skipWaiting: async () => {},
      fetch: async () => new Response('inactive', {status: 404}),
    });
  };
  restart();
  vm.runInNewContext(hostCode, {...common,
    location: {search: '?parentOrigin=http://app'},
    addEventListener(type, callback) { hostEvents[type] = callback; },
    navigator: {serviceWorker: {
      addEventListener(type, callback) { hostWorkerEvents[type] = callback; },
      register: async () => ({active: worker}),
      getRegistration: async () => ({active: worker}),
    }},
  });
  const message = (port) => new Promise(resolve => port.addEventListener('message', event => resolve(event.data), {once: true}));
  const fetchGuest = (path) => {
    let result;
    workerEvents.fetch({request: new Request('http://host' + path), respondWith(value) {result = value;}});
    return result;
  };
  try {
    const control = new TrackedChannel();
    control.port1.start();
    const connected = message(control.port1);
    hostEvents.message({origin: 'http://app', data: {type:'wasmer-sdk:http-host-connect'}, ports:[control.port2]});
    assert.equal((await connected).type, 'wasmer-sdk:http-host-ready');
    const owner = new TrackedChannel();
    owner.port1.start();
    owner.port1.addEventListener('message', ({data}) => {
      if (data.type === 'wasmer-sdk:http-request') owner.port1.postMessage({
        type:'wasmer-sdk:http-response', serverId:data.serverId, requestId:data.requestId,
        status:200, body:new TextEncoder().encode(data.path),
      });
    });
    const ready = message(owner.port1);
    control.port1.postMessage({type:'wasmer-sdk:http-register', serverId:'original'}, [owner.port2]);
    assert.equal((await ready).type, 'wasmer-sdk:http-ready');
    assert.equal(await (await fetchGuest('/before')).text(), '/before');
    restart();
    const before = recoveries;
    const responses = await Promise.all(['/one','/two','/three'].map(fetchGuest));
    assert.deepEqual(await Promise.all(responses.map(r => r.text())), ['/one','/two','/three']);
    assert.equal(recoveries, before + 1, 'concurrent fetches share one recovery');
    restart();
    const duplicate = new TrackedChannel(); duplicate.port1.start();
    const rejected = message(duplicate.port1);
    control.port1.postMessage({type:'wasmer-sdk:http-register', serverId:'duplicate'}, [duplicate.port2]);
    assert.equal((await rejected).type, 'wasmer-sdk:http-error');
    assert.equal(await (await fetchGuest('/original')).text(), '/original');
    owner.port1.postMessage({type:'wasmer-sdk:http-close', serverId:'original'});
    await new Promise(resolve => setTimeout(resolve, 20));
    restart();
    assert.equal((await fetchGuest('/closed')).status, 404, 'closed routes are not resurrected');
  } finally {
    for (const port of ports) port.close();
  }
});
