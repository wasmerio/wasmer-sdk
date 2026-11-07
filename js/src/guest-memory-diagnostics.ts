/** Guest memories created in one worker isolate. Test diagnostics only. */
export interface GuestMemoryCounters {
  /** Shared memories constructed in this isolate (guest memories). */
  created: number;
  /** Of those, how many the garbage collector has finalized. */
  finalized: number;
  /** Not yet collected, whether in use or dead. */
  liveCount: number;
  liveBytes: number;
}

/**
 * Count the guest memories this isolate creates, and how many are still
 * alive. Wraps the `WebAssembly.Memory` constructor, so install it only
 * for tests: the SDK's own memory is passed to workers, never constructed in
 * them, so every shared memory constructed here belongs to a guest.
 */
export function installGuestMemoryCounters(): () => GuestMemoryCounters {
  const live = new Set<WeakRef<WebAssembly.Memory>>();
  let created = 0;
  let finalized = 0;
  const registry = new FinalizationRegistry<WeakRef<WebAssembly.Memory>>(
    (reference) => {
      finalized += 1;
      live.delete(reference);
    },
  );
  const wasm = WebAssembly as { Memory: typeof WebAssembly.Memory };
  wasm.Memory = new Proxy(wasm.Memory, {
    construct(target, args, newTarget) {
      const memory = Reflect.construct(target, args, newTarget) as WebAssembly.Memory;
      if ((args[0] as { shared?: boolean } | undefined)?.shared) {
        created += 1;
        const reference = new WeakRef(memory);
        live.add(reference);
        registry.register(memory, reference);
      }
      return memory;
    },
  });
  return () => {
    let liveCount = 0;
    let liveBytes = 0;
    for (const reference of live) {
      const memory = reference.deref();
      if (!memory) continue;
      liveCount += 1;
      liveBytes += memory.buffer.byteLength;
    }
    return { created, finalized, liveCount, liveBytes };
  };
}
