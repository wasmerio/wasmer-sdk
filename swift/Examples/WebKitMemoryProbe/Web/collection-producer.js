import { collect, collectionMethod, countLive } from './collection.js';

const options = new URL(location.href).searchParams;
const gcMode = options.get('gcMode') ?? 'none';
const workerCount = Number(options.get('workers') ?? 20);
const iterations = Number(options.get('iterations') ?? 2000);
if (!['none', 'producer', 'receivers'].includes(gcMode) || !Number.isInteger(workerCount)
    || workerCount < 1 || workerCount > 64 || !Number.isInteger(iterations)
    || iterations < 1) throw new Error('Invalid collection probe options');
const workers = Array.from({ length: workerCount }, () =>
  new Worker('./collection-consumer.js', { type: 'module' }));
const refs = [];
function send(worker, data) {
  return new Promise((resolve, reject) => {
    worker.onmessage = resolve;
    worker.onerror = reject;
    worker.postMessage(data);
  });
}
async function inspectReceivers(type) {
  const replies = await Promise.all(workers.map(worker => send(worker, { type })));
  return replies.map(event => event.data).reduce((a, b) => ({
    tracked: a.tracked + b.tracked, alive: a.alive + b.alive,
    buffers: { tracked: a.buffers.tracked + b.buffers.tracked,
      alive: a.buffers.alive + b.buffers.alive },
  }), { tracked: 0, alive: 0, buffers: { tracked: 0, alive: 0 } });
}
function allocate() {
  return new WebAssembly.Memory({ initial: 133, maximum: 2048, shared: true });
}
function retry() {
  try { allocate(); return 'success'; } catch (error) { return String(error); }
}
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
let count = 0;
let error;
try {
  for (; count < iterations; count++) {
    const memory = allocate();
    refs.push(new WeakRef(memory));
    const worker = workers[count % workers.length];
    await send(worker, { memory, id: count });
    // A separate message ensures the receiver's previous handler has returned.
    if (gcMode === 'receivers') await send(worker, { type: 'collect' });
    if (gcMode === 'producer') collect();
  }
} catch (caught) { error = String(caught); }
const result = {
  kind: 'result', probe: 'collection', gcMode, workers: workerCount, iterations,
  count, passed: count === iterations, error: error ?? null, collectionMethod,
  producerBefore: countLive(refs), receiversBefore: await inspectReceivers('stats'),
};
await nextTask();
collect();
result.producerAfter = countLive(refs);
result.retryAfterProducerCollection = retry();
result.receiversAfter = await inspectReceivers('collect');
await nextTask();
collect();
result.retryAfterReceiverCollection = retry();
postMessage(result);
