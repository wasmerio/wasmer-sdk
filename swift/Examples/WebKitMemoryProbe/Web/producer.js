// No Wasm module, SDK, WASIX, JSPI, or package manager is involved.
const options = new URL(location.href).searchParams;
const mode = options.get('mode') ?? 'shared';
const workerCount = Number(options.get('workers') ?? 20);
const iterations = Number(options.get('iterations') ?? 2000);
const delayMs = Number(options.get('delayMs') ?? 0);
const recycleEvery = Number(options.get('recycleEvery') ?? 0);
const initial = Number(options.get('initial') ?? 133);
const maximum = Number(options.get('maximum') ?? 2048);
const receiverAccess = options.get('receiverAccess') ?? 'buffer';
if (!['shared', 'local'].includes(mode) || !Number.isInteger(workerCount)
    || workerCount < 1 || workerCount > 64 || !Number.isInteger(iterations)
    || iterations < 1 || !Number.isFinite(delayMs) || delayMs < 0
    || !Number.isInteger(recycleEvery) || recycleEvery < 0
    || !Number.isInteger(initial) || !Number.isInteger(maximum)
    || initial < 1 || maximum < initial || maximum > 65536
    || !['buffer', 'ignore'].includes(receiverAccess))
  throw new Error('Invalid probe options');

const createWorkers = () => Array.from({ length: workerCount }, () =>
  new Worker(`./consumer.js?receiverAccess=${receiverAccess}`, { type: 'module' }));
let workers = createWorkers();

function send(worker, message) {
  return new Promise((resolve, reject) => {
    // Assign resolve directly: an additional closure can accidentally keep the
    // message (and its memory) reachable through the worker's event listener.
    worker.onmessage = resolve;
    worker.onerror = reject;
    worker.postMessage(message);
  });
}

let count = 0;
const started = performance.now();
function report(kind, extra = {}) {
  postMessage({ kind, mode, workers: workerCount, iterations, delayMs, recycleEvery,
    initial, maximum, receiverAccess, count,
    elapsedMs: Math.round(performance.now() - started), ...extra });
}
try {
  for (; count < iterations; count++) {
    if (recycleEvery && count && count % recycleEvery === 0) {
      // Diagnostic only: these receivers have no task left after their ack.
      for (const worker of workers) worker.terminate();
      workers = createWorkers();
    }
    const memory = new WebAssembly.Memory({ initial, maximum, shared: true });
    // Both modes allocate the same memory and wait for the same worker ack.
    // Only shared mode gives the receiver another wrapper for that memory.
    await send(workers[count % workers.length], mode === 'shared'
      ? { memory, id: count } : { id: count });
    if (count % 100 === 0) report('progress');
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  report('result', { passed: true });
} catch (error) {
  report('result', { passed: false, error: String(error), stack: error.stack ?? '' });
}
// Keep workers alive until the host closes the page so diagnostics can inspect
// the failing state. Neither side keeps a collection of guest memories.
