import { BrowserRuntime, type RuntimeAssets } from "./runtime.js";

interface Stdio {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  outputDrained: Promise<void>;
  abort(reason: unknown): Promise<void>;
  resize(size: { rows: number; cols: number }): Promise<void>;
  hangup(): Promise<void>;
}
type CreateStdio = (bridge: object) => Stdio;

export interface RawSpawnOptions {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  mounts?: Readonly<Record<string, LiveDirectory>>;
  terminal?: { columns: number; rows: number };
}

/** Internal local-byte slice; current/classic public wrappers remain separate. */
export class RawBrowserCore {
  private constructor(
    readonly runtime: BrowserRuntime,
    private readonly createStdio: CreateStdio,
  ) {}

  static async open(options: RuntimeAssets): Promise<RawBrowserCore> {
    const baseUrl = new URL(options.baseUrl, globalThis.location.href);
    const { createStdio } = await import(new URL("web-streams.mjs", baseUrl).href);
    return new RawBrowserCore(await BrowserRuntime.open(options), createStdio);
  }

  async directory(): Promise<LiveDirectory> {
    return new LiveDirectory(this.runtime, (await this.runtime.request("directory_new")).value as number);
  }

  async spawn(bytes: Uint8Array, options: RawSpawnOptions = {}): Promise<RawProcess> {
    // Own the module/configuration before acquisition or admission yields.
    const snapshot = new Uint8Array(bytes);
    const mounts = Object.entries(options.mounts ?? {}).map(([path, directory]) => {
      if (directory.runtime !== this.runtime) throw new Error("directory belongs to another SDK runtime");
      return [path, directory.handle];
    });
    const settings = {
      args: [...(options.args ?? ["wasm"])],
      env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
      cwd: options.cwd ?? null, mounts,
      terminal: options.terminal ? [options.terminal.columns, options.terminal.rows] : null,
    };
    const module = await this.runtime.upload(snapshot);
    let configuration: number | undefined;
    let reservation: number | undefined;
    try {
      configuration = await this.runtime.upload(new TextEncoder().encode(JSON.stringify({ ...settings, buffer: module })));
      reservation = await this.runtime.reserveMachine();
      const process = (await this.runtime.request("spawn", reservation, { config: configuration })).value as { handle: number; pid: number };
      return new RawProcess(this.runtime, process.handle, process.pid, this.createStdio);
    } catch (error) {
      if (reservation !== undefined) await this.runtime.request("abandon_machine", reservation).catch(() => {});
      throw error;
    } finally {
      await this.runtime.request("buffer_drop", module).catch(() => {});
      if (configuration !== undefined) await this.runtime.request("buffer_drop", configuration).catch(() => {});
    }
  }

  close(): Promise<void> { return this.runtime.close(); }
}

export class RawProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly #stdio: Stdio;
  readonly #detachStop: () => void;
  #wait: Promise<number> | undefined;

  constructor(private readonly runtime: BrowserRuntime, private readonly handle: number, readonly id: number, createStdio: CreateStdio) {
    const request = (operation: string, metadata: unknown = null, bytes?: Uint8Array) =>
      runtime.request(operation, handle, metadata, bytes);
    this.#stdio = createStdio({
      writeInput: async (bytes: Uint8Array) => (await request("write_input", null, bytes)).value,
      closeInput: async () => { await request("close_input"); },
      abortInput: async () => { await request("abort_input"); },
      readOutput: async (stream: string, max: number) => {
        const reply = await request("read_output", { stream, max });
        return reply.value === 0 ? null : reply.bytes;
      },
      cancelOutput: async (stream: string) => { await request("cancel_output", { stream }); },
      resize: async (size: object) => { await request("resize", size); },
      hangup: async () => { await request("hangup"); },
    });
    this.stdin = this.#stdio.stdin;
    this.stdout = this.#stdio.stdout;
    this.stderr = this.#stdio.stderr;
    this.#detachStop = runtime.onStop(error => { void this.#stdio.abort(error).catch(() => {}); });
  }

  wait(): Promise<number> {
    return this.#wait ??= Promise.all([
      this.runtime.request("wait", this.handle), this.#stdio.outputDrained,
    ]).then(([reply]) => reply.value as number).finally(this.#detachStop);
  }
  async kill(): Promise<void> { await this.runtime.request("kill", this.handle); }
  async signal(signal: number): Promise<void> { await this.runtime.request("signal", this.handle, { signal }); }
  resize(columns: number, rows: number): Promise<void> { return this.#stdio.resize({ cols: columns, rows }); }
  hangup(): Promise<void> { return this.#stdio.hangup(); }
}

/** Every mount and edit retains this remote WebFs owner; no snapshot mount. */
export class LiveDirectory {
  constructor(readonly runtime: BrowserRuntime, readonly handle: number) {}

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const snapshot = new Uint8Array(bytes);
    const file = (await this.runtime.request("file_open", this.handle, { path, write: true })).value as number;
    try {
      for (let offset = 0; offset < snapshot.byteLength;) {
        const chunk = snapshot.subarray(offset, offset + 65536);
        const count = (await this.runtime.request("file_write", file, { offset }, chunk)).value as number;
        if (!Number.isInteger(count) || count <= 0 || count > chunk.length) throw new Error("invalid SDK file write count");
        offset += count;
      }
    } finally { await this.runtime.request("file_close", file); }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = (await this.runtime.request("file_open", this.handle, { path, write: false })).value as number;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const reply = await this.runtime.request("file_read", file, { offset: length });
        if (reply.value === 0) break;
        chunks.push(reply.bytes);
        length += reply.bytes.byteLength;
      }
    } finally { await this.runtime.request("file_close", file); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }

  async mkdir(path: string, recursive = false): Promise<void> { await this.runtime.request("mkdir", this.handle, { path, recursive }); }
  async rename(path: string, to: string): Promise<void> { await this.runtime.request("rename", this.handle, { path, to }); }
}
