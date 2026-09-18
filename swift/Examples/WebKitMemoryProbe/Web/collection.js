// Diagnostic only. Neither explicit GC nor allocation pressure is an SDK fix.
export const collectionMethod = typeof globalThis.gc === 'function'
  ? 'explicit GC' : '128 MiB temporary allocation pressure';

export function collect() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return;
  }
  // At most a few arrays need to stay live. A global store prevents the work
  // from being optimized away. This requests no guaranteed GC on WebKit.
  for (let i = 0; i < 128; i++) globalThis.pressureScratch = new Array(131072).fill(i);
  globalThis.pressureScratch = null;
}

export function countLive(refs) {
  // deref keeps surviving objects alive until this job ends. Inspect only at
  // phase boundaries, and allow another task before attempting collection.
  return { tracked: refs.length, alive: refs.filter(ref => ref.deref()).length };
}
