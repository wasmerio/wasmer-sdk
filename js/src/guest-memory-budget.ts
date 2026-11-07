/** How long a worker stays idle before it collects released guest memory. */
export const IDLE_COLLECTION_DELAY_MS = 1_000;

/**
 * Releases the memory of finished guests in a pooled worker (wasmer-sdk#547).
 *
 * Every WASIX process gets its own shared `WebAssembly.Memory`. Once the
 * process has finished and the pool has dropped its roots, only this
 * worker's garbage collector can free that memory. JavaScript engines rarely
 * collect it on their own: an idle isolate never collects, and shared
 * backing stores create little or no external-memory pressure. This turns
 * the pool's "roots dropped" notification into a bound on the dead guest
 * memory each worker keeps:
 *
 * - When one more guest of the largest size seen so far could take the
 *   released memory past the budget, the worker collects right away,
 *   before it starts the next guest.
 * - Otherwise it collects once it has been idle for a moment. A blocking
 *   task (a guest thread or blocking job) cancels that, so a busy worker
 *   only collects when the budget requires it: every forced collection also
 *   throws away optimized code.
 * - Where no garbage-collection hook is available it asks the pool to
 *   retire the worker instead. Stopping a worker disposes its isolate and
 *   every memory in it. The request can cross a guest already on its way to
 *   this worker, so such a worker asks while there is still room for two
 *   more guests.
 *
 * Timer and asynchronous-job messages never trigger a collection.
 */
export class GuestMemoryBudget {
  readonly #budget: number;
  readonly #obtainCollector: () => (() => void) | null;
  readonly #requestRetirement: () => void;
  #collector: (() => void) | null | undefined;
  #released = 0;
  #largest = 0;
  #blockingTasks = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #retirementRequested = false;
  /** Counters for tests and diagnostics. */
  readonly stats = {
    budgetCollections: 0,
    idleCollections: 0,
    collectionMs: 0,
    retirementRequests: 0,
  };

  constructor(options: {
    /** Bytes of dead guest memory this worker may keep; 0 disables. */
    budget: number;
    /** Lazily returns a function that runs one full collection, or null. */
    obtainCollector: () => (() => void) | null;
    /** Ask the pool to stop this worker once it is idle. */
    requestRetirement: () => void;
  }) {
    this.#budget = options.budget > 0 ? options.budget : 0;
    this.#obtainCollector = options.obtainCollector;
    this.#requestRetirement = options.requestRetirement;
  }

  /** Bytes of dead guest memory not yet collected in this worker. */
  get released(): number {
    return this.#released;
  }

  /**
   * The pool dropped this worker's roots, after it finished guest threads
   * whose memories add up to `bytes`.
   */
  release(bytes: number): void {
    if (this.#budget === 0) return;
    if (bytes > 0) {
      this.#released += bytes;
      this.#largest = Math.max(this.#largest, bytes);
    }
    if (this.#released === 0) return;
    const reserve = this.#getCollector() ? this.#largest : 2 * this.#largest;
    if (this.#released + reserve > this.#budget) this.#collect("budget");
    // Collections for other workers' guests must not postpone this one.
    else if (bytes > 0 || this.#idleTimer === undefined) {
      this.#scheduleIdleCollection();
    }
  }

  /** A blocking task starts on this worker. */
  blockingTaskStarted(): void {
    this.#blockingTasks += 1;
    this.#cancelIdleCollection();
    // The pool gave this worker work instead of retiring it; ask again once
    // it is idle.
    this.#retirementRequested = false;
  }

  blockingTaskFinished(): void {
    this.#blockingTasks -= 1;
    // A blocking job that ran no guest is followed by no release.
    if (this.#blockingTasks === 0 && this.#released > 0) {
      this.#scheduleIdleCollection();
    }
  }

  #scheduleIdleCollection(): void {
    this.#cancelIdleCollection();
    const timer = setTimeout(() => {
      this.#idleTimer = undefined;
      // A blocking task that yielded is still running; the release after it
      // finishes schedules the collection again.
      if (this.#blockingTasks > 0 || this.#released === 0) return;
      this.#collect("idle");
    }, IDLE_COLLECTION_DELAY_MS);
    // Never keep a Node worker alive just to collect.
    (timer as { unref?: () => void }).unref?.();
    this.#idleTimer = timer;
  }

  #cancelIdleCollection(): void {
    if (this.#idleTimer === undefined) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #getCollector(): (() => void) | null {
    if (this.#collector === undefined) this.#collector = this.#obtainCollector();
    return this.#collector;
  }

  #collect(reason: "budget" | "idle"): void {
    this.#cancelIdleCollection();
    const collector = this.#getCollector();
    if (collector) {
      const started = performance.now();
      try {
        collector();
        this.stats.collectionMs += performance.now() - started;
        if (reason === "budget") this.stats.budgetCollections += 1;
        else this.stats.idleCollections += 1;
        this.#released = 0;
        return;
      } catch {
        // Do not trust a collector that failed once.
        this.#collector = null;
      }
    }
    if (this.#retirementRequested) return;
    this.#retirementRequested = true;
    this.stats.retirementRequests += 1;
    this.#requestRetirement();
  }
}
