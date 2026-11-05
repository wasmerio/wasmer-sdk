/** Internal v2 transport over the existing B2 root-entry and event hooks. */
const FRAME_BYTES = 64 * 1024;
const MAX_DATA_OPERATIONS = 128;
const MAX_CONTROL_OPERATIONS = 32;
const controls = new Set(["close", "release_machine", "abandon_machine", "kill", "signal", "resize", "hangup", "close_input", "abort_input", "cancel_output"]);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export interface Reply {
  value: unknown;
  bytes: Uint8Array;
}
interface Operation extends Deferred<Reply> {
  id: number;
  operation: string;
  handle: number;
  metadata: string;
  bytes: Uint8Array<ArrayBuffer>;
  control: boolean;
}
interface ServiceFence {
  worker: number;
  idle: boolean;
}
interface MachineFence {
  tokens: number[];
  releasing: boolean;
}

export interface RuntimeAssets {
  /** Version-matched source-built binding, memory limits and B2 worker assets. */
  baseUrl: string | URL;
  wasm?: WebAssembly.Module | BufferSource;
  taskLimit?: number;
  machineLimit?: number;
}

let nextGeneration = 1;

export class BrowserRuntime {
  readonly #generation = nextGeneration++;
  readonly #pending = new Map<number, Operation>();
  readonly #data: Operation[] = [];
  readonly #controls: Operation[] = [];
  readonly #finished = new Map<number, ServiceFence>();
  readonly #machines = new Map<number, MachineFence>();
  readonly #reservations = new Set<number>();
  readonly #kills = new Map<number, Promise<Reply>>();
  readonly #opened = deferred<void>();
  readonly #closed = deferred<void>();
  readonly #stopped = deferred<void>();
  readonly #admissionWaiters: Deferred<void>[] = [];
  readonly #stopListeners = new Set<(error: Error) => void>();
  #stopReason: Error | undefined;
  #worker: Worker | undefined;
  #ack: Deferred<boolean> | undefined;
  #nextOperation = 1;
  #dataCount = 0;
  #controlCount = 0;
  #killCount = 0;
  #closePending = false;
  #capacity = 0;
  #pumping = false;
  #submitting: Operation | undefined;
  #closing = false;
  #runtimeClosed = false;
  #failure: Error | undefined;
  #close: Promise<void> | undefined;
  #admitted = 0;
  #controlBurst = 0;

  private constructor(readonly machineLimit: number) {
    // Bootstrap/fatal can precede attaching public waiters.
    for (const value of [this.#opened, this.#closed, this.#stopped]) value.promise.catch(() => {});
  }

  static async open(options: RuntimeAssets): Promise<BrowserRuntime> {
    const taskLimit = options.taskLimit ?? 64;
    const machineLimit = options.machineLimit ?? Math.min(8, taskLimit);
    if (!Number.isSafeInteger(taskLimit) || taskLimit < 1 || taskLimit > 1024 ||
        !Number.isSafeInteger(machineLimit) || machineLimit < 1 || machineLimit > taskLimit || machineLimit > 64) {
      throw new RangeError("invalid bounded SDK worker capacity");
    }
    const baseUrl = new URL(options.baseUrl, globalThis.location.href);
    const [{ startCoordinator }, { default: descriptor }] = await Promise.all([
      import(new URL("bootstrap.js", baseUrl).href),
      import(new URL("limits.js", baseUrl).href),
    ]);
    const source = options.wasm ?? await (async () => {
      const response = await fetch(new URL("runtime_bg.wasm", baseUrl));
      if (!response.ok) throw new Error(`SDK runtime fetch failed: ${response.status}`);
      return response.arrayBuffer();
    })();
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const runtime = new BrowserRuntime(machineLimit);
    try {
      runtime.#worker = await startCoordinator({
        module, memory: new WebAssembly.Memory(descriptor),
        bindingsUrl: new URL("runtime.js", baseUrl).href,
        workerUrl: new URL("worker.js", baseUrl).href,
        coordinatorUrl: new URL("coordinator.js", baseUrl).href,
        memoryCopyUrl: new URL("memory/copy-worker.js", baseUrl).href,
        configure: "configure_browser", disableJSPI: true, disableWaitAsync: true,
        forbidWorkerCreation: true, taskLimit, serviceLimit: 1 + 2 * machineLimit,
        prewarm: Math.min(2, taskLimit), servicePrewarm: 1,
        stackSize: 2 * 1024 * 1024, admissionTimeout: 10000,
      }, (data: Record<string, unknown>) => runtime.#receive(data));
      await runtime.#entry("sdk_open", [runtime.#generation, taskLimit, machineLimit]);
      await runtime.#opened.promise;
      return runtime;
    } catch (cause) {
      runtime.#fail(cause);
      throw runtime.#failure;
    }
  }

  onStop(callback: (error: Error) => void): () => void {
    if (this.#failure) callback(this.#failure);
    else if (this.#stopReason) callback(this.#stopReason);
    else this.#stopListeners.add(callback);
    return () => this.#stopListeners.delete(callback);
  }

  request(operation: string, handle = 0, metadata: unknown = null, bytes: Uint8Array<ArrayBufferLike> = new Uint8Array()): Promise<Reply> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#runtimeClosed) return Promise.reject(new Error("SDK runtime is closed"));
    const control = controls.has(operation);
    if (operation.length > 64) return Promise.reject(new RangeError("invalid SDK operation name"));
    if (this.#closing && control && operation !== "close" && operation !== "release_machine") {
      // Rust close already cancels every stream and genuinely stops every
      // owned launch/tree. No fresh control may outlive that driver's owner.
      return this.#closed.promise.then(() => ({ value: null, bytes: new Uint8Array() }));
    }
    if (operation === "kill") {
      const pending = this.#kills.get(handle);
      if (pending) return pending;
    }
    if (this.#closing && !control) return Promise.reject(new Error("SDK client is closing"));
    if (bytes.byteLength > FRAME_BYTES || (control && bytes.byteLength !== 0)) {
      return Promise.reject(new RangeError("invalid SDK transport frame"));
    }
    let encoded: string;
    try {
      const value = JSON.stringify(metadata);
      if (typeof value !== "string") throw new TypeError("invalid SDK metadata");
      encoded = value;
    } catch (error) { return Promise.reject(error); }
    if (new TextEncoder().encode(encoded).byteLength > FRAME_BYTES) {
      return Promise.reject(new RangeError("SDK metadata frame is too large"));
    }
    const full = operation === "close" ? this.#closePending
      : operation === "kill" ? this.#killCount >= this.machineLimit
      : control ? this.#ordinaryControls() >= MAX_CONTROL_OPERATIONS
      : this.#dataCount >= MAX_DATA_OPERATIONS;
    if (full) {
      return Promise.reject(new Error("SDK pending operation capacity is full"));
    }
    if (this.#nextOperation > 0xffff_ffff) return Promise.reject(new Error("SDK operation identity exhausted"));
    const request: Operation = { ...deferred<Reply>(), id: this.#nextOperation++, operation,
      handle, metadata: encoded, bytes: new Uint8Array(bytes), control };
    // Register before enqueue: service completion can precede the root's ack.
    this.#pending.set(request.id, request);
    if (control) {
      this.#controlCount++;
      if (operation === "kill") this.#killCount++;
      if (operation === "close") { this.#closePending = true; this.#controls.unshift(request); }
      else this.#controls.push(request);
    }
    else { this.#dataCount++; this.#data.push(request); }
    void this.#pump();
    if (operation === "kill") {
      this.#kills.set(handle, request.promise);
      void request.promise.then(() => this.#kills.delete(handle), () => this.#kills.delete(handle));
    }
    return request.promise;
  }

  async upload(bytes: Uint8Array): Promise<number> {
    const handle = (await this.request("buffer_new")).value as number;
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += FRAME_BYTES) {
        await this.request("buffer_append", handle, null, bytes.subarray(offset, offset + FRAME_BYTES));
      }
      await this.request("buffer_seal", handle);
      return handle;
    } catch (error) {
      await this.request("buffer_drop", handle).catch(() => {});
      throw error;
    }
  }

  async reserveMachine(): Promise<number> {
    if (this.#failure) throw this.#failure;
    if (this.#closing) throw new Error("SDK client is closing");
    while (this.#admitted >= this.machineLimit) {
      const waiter = deferred<void>();
      this.#admissionWaiters.push(waiter);
      await waiter.promise;
      if (this.#failure) throw this.#failure;
      if (this.#closing) throw new Error("SDK client is closing");
    }
    this.#admitted++;
    try {
      const handle = (await this.request("reserve_machine")).value as number;
      this.#reservations.add(handle);
      return handle;
    }
    catch (error) { this.#admitted--; this.#wakeAdmission(); throw error; }
  }

  close(): Promise<void> {
    return this.#close ??= (async () => {
      if (this.#failure) throw this.#failure;
      this.#closing = true;
      // Work still waiting on the page has no Rust owner. Reject it now rather
      // than dispatching fresh data after the service driver has closed.
      for (const request of [...this.#data, ...this.#controls]) {
        if (request === this.#submitting || request.operation === "release_machine") continue;
        this.#dropQueued(request);
        if (request.operation === "kill") {
          void this.#closed.promise.then(() => request.resolve({ value: null, bytes: new Uint8Array() }), request.reject);
        } else request.reject(new Error("SDK client is closing"));
      }
      for (const waiter of this.#admissionWaiters.splice(0)) waiter.reject(new Error("SDK client is closing"));
      let closeError: unknown;
      try { await this.request("close"); }
      catch (error) { closeError = error; }
      // Rust keeps its SDK driver admitted until every Machine's actual B2
      // service-idle fence releases the reservation.
      await this.#closed.promise;
      await this.#untilIdle();
      this.#worker!.postMessage({ type: "shutdown" });
      await this.#stopped.promise;
      this.#worker = undefined;
      if (closeError !== undefined) throw closeError;
    })();
  }

  async #entry(entry: string, args: unknown[]): Promise<boolean> {
    if (this.#failure) throw this.#failure;
    if (this.#ack) throw new Error("SDK root entry is already active");
    const ack = deferred<boolean>();
    this.#ack = ack;
    try {
      this.#worker!.postMessage({ type: "entry", entry, args });
      return await ack.promise;
    } finally { this.#ack = undefined; }
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#failure) return;
    this.#pumping = true;
    try {
      for (;;) {
        const queue = this.#controls.length && (!this.#data.length || this.#controlBurst < 8) ? this.#controls : this.#data;
        const request = queue[0];
        if (!request) break;
        const capacity = this.#capacity;
        this.#submitting = request;
        let accepted: boolean;
        try {
          accepted = await this.#entry("sdk_submit", [request.id, request.operation,
            request.handle, request.metadata, request.bytes]);
        } finally { this.#submitting = undefined; }
        if (accepted) {
          const index = queue.indexOf(request);
          if (index >= 0) queue.splice(index, 1);
          this.#controlBurst = request.control ? this.#controlBurst + 1 : 0;
        }
        else if (this.#runtimeClosed || (this.#closing && !request.control)) {
          this.#rejectQueued(request, new Error("SDK client is closing"));
        } else if (this.#capacity === capacity) {
          // A close inserted during this acknowledgement has independent
          // admission and must not wait for the rejected lane's next capacity.
          if (this.#controls[0]?.operation === "close" && this.#controls[0] !== request) continue;
          break;
        }
      }
    } catch (cause) { this.#fail(cause); }
    finally { this.#pumping = false; }
  }

  #receive(data: Record<string, unknown>): void {
    if (this.#failure) return;
    if (data.type === "fatal") { this.#fail(new Error(String(data.error))); return; }
    if (data.type === "result") { this.#ack?.resolve(data.result !== false); return; }
    if (data.type === "stopped") { this.#stopped.resolve(); return; }
    if (data.type === "idle") {
      const worker = data.worker as number;
      // Only bounded, owned service tokens need an idle fence. Task worker IDs
      // may rotate indefinitely and must not become historical SDK state.
      for (const service of this.#finished.values()) {
        if (service.worker === worker) service.idle = true;
      }
      this.#checkFences();
      return;
    }
    if (data.type === "stats") { this.#stats?.resolve(data); return; }
    if (data.type !== "event") return;
    const event = data.value as { sdk?: boolean; generation?: number; kind: string; value: any; bytes: Uint8Array };
    if (!event?.sdk || event.generation !== this.#generation) return;
    switch (event.kind) {
      case "opened": this.#opened.resolve(); break;
      case "closed":
        this.#runtimeClosed = true;
        // Rust has genuinely stopped every tree and settled admitted operations.
        // Unread JS streams are canceled, never reported as successfully drained.
        this.#notifyStop(new DOMException("SDK client closed before its streams drained", "AbortError"));
        this.#closed.resolve();
        break;
      case "capacity": this.#capacity++; void this.#pump(); break;
      case "result": {
        const request = this.#pending.get(event.value.id);
        if (!request) break;
        this.#pending.delete(request.id);
        if (request.control) this.#controlCount--; else this.#dataCount--;
        if (request.operation === "kill") this.#killCount--;
        if (request.operation === "close") this.#closePending = false;
        if (event.value.ok) request.resolve({ value: event.value.value, bytes: event.bytes });
        else {
          void this.#readError(event.value.error).then(message => request.reject(new Error(message)), request.reject);
        }
        this.#checkFences();
        break;
      }
      case "service_finished": {
        if (!this.#reservations.has(event.value.machine)) break;
        const worker = data.worker as number;
        const token = event.value.token as number;
        if (!this.#finished.has(token)) this.#finished.set(token, { worker, idle: false });
        this.#checkFences();
        break;
      }
      case "machine_released":
        if (!this.#reservations.has(event.value.machine)) break;
        if (!this.#machines.has(event.value.machine)) this.#machines.set(event.value.machine, { tokens: event.value.tokens, releasing: false });
        this.#checkFences();
        break;
    }
  }

  #checkFences(): void {
    for (const [machine, fence] of this.#machines) {
      // Leave reserved capacity for user kill/close even when many Machines
      // finish together. Retry remaining fences as control replies settle.
      if (this.#ordinaryControls() >= MAX_CONTROL_OPERATIONS / 2) break;
      if (fence.releasing || !fence.tokens.every(token => {
        const service = this.#finished.get(token);
        return service?.idle;
      })) continue;
      fence.releasing = true;
      void this.request("release_machine", machine).then(() => {
        this.#machines.delete(machine);
        this.#reservations.delete(machine);
        for (const token of fence.tokens) this.#finished.delete(token);
        this.#admitted--;
        this.#wakeAdmission();
      }).catch(error => this.#fail(error));
    }
  }

  #wakeAdmission(): void { this.#admissionWaiters.shift()?.resolve(); }
  async #readError(error: string | { buffer: number; size: number }): Promise<string> {
    if (typeof error === "string") return error;
    const bytes = new Uint8Array(error.size);
    try {
      for (let offset = 0; offset < bytes.length;) {
        const reply = await this.request("buffer_read", error.buffer, { offset });
        if (reply.bytes.length === 0 || reply.bytes.length > bytes.length - offset) throw new Error("invalid SDK error frame");
        bytes.set(reply.bytes, offset);
        offset += reply.bytes.length;
      }
      return new TextDecoder().decode(bytes);
    } finally { await this.request("buffer_drop", error.buffer).catch(() => {}); }
  }
  #rejectQueued(request: Operation, error: Error): void {
    this.#dropQueued(request);
    request.reject(error);
  }
  #dropQueued(request: Operation): void {
    const queue = request.control ? this.#controls : this.#data;
    const index = queue.indexOf(request);
    if (index >= 0) queue.splice(index, 1);
    this.#pending.delete(request.id);
    if (request.control) this.#controlCount--; else this.#dataCount--;
    if (request.operation === "kill") this.#killCount--;
    if (request.operation === "close") this.#closePending = false;
  }
  #ordinaryControls(): number { return this.#controlCount - this.#killCount - Number(this.#closePending); }
  #stats: Deferred<Record<string, any>> | undefined;
  async #untilIdle(): Promise<void> {
    for (;;) {
      const stats = deferred<Record<string, any>>();
      this.#stats = stats;
      this.#worker!.postMessage({ type: "stats" });
      const state = await stats.promise;
      this.#stats = undefined;
      if (state.admissions === 0 && state.workers.every((worker: { status: string }) => worker.status === "idle")) return;
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
  }

  #fail(cause: unknown): void {
    if (this.#failure) return;
    const failure = this.#failure = cause instanceof Error ? cause : new Error(String(cause));
    this.#ack?.reject(failure);
    this.#stats?.reject(failure);
    for (const value of [this.#opened, this.#closed, this.#stopped]) value.reject(failure);
    for (const request of this.#pending.values()) request.reject(failure);
    for (const waiter of this.#admissionWaiters.splice(0)) waiter.reject(failure);
    this.#pending.clear(); this.#data.length = this.#controls.length = 0;
    this.#machines.clear(); this.#finished.clear(); this.#kills.clear(); this.#reservations.clear();
    this.#worker?.terminate(); this.#worker = undefined;
    this.#notifyStop(failure);
  }

  #notifyStop(reason: Error): void {
    if (this.#stopReason) return;
    this.#stopReason = reason;
    const listeners = [...this.#stopListeners];
    this.#stopListeners.clear();
    for (const callback of listeners) { try { callback(reason); } catch {} }
  }
}
