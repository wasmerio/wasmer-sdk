import v8 from "node:v8";
import vm from "node:vm";

/**
 * A function that runs one full garbage collection of the calling isolate,
 * or null where none is available.
 *
 * Bun exposes one. Node exposes `gc` only with `--expose-gc`; otherwise the
 * flag is switched on just long enough to create one throwaway context that
 * has `gc`, and switched off again at once. V8 flags are process-wide, so
 * contexts created afterwards (user code, guests, other workers) never get a
 * `gc` global. Any failure, such as flags frozen by an embedder, returns
 * null.
 */
export function obtainGarbageCollector(): (() => void) | null {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  if (typeof bun?.gc === "function") return () => bun.gc!(true);
  const exposed = (globalThis as { gc?: unknown }).gc;
  if (typeof exposed === "function") return () => (exposed as () => void)();
  let collector: unknown;
  try {
    v8.setFlagsFromString("--expose-gc");
    collector = vm.runInNewContext("gc");
  } catch {
    collector = undefined;
  } finally {
    try {
      v8.setFlagsFromString("--no-expose-gc");
    } catch {
      // The flag could not be set either.
    }
  }
  return typeof collector === "function"
    ? () => (collector as () => void)()
    : null;
}
