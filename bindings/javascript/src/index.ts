import init, {
  WasmerCore,
  type CommandCore,
  type PackageCore,
  type ProcessCore,
  type SandboxCore,
} from "../pkg/wasmer_sdk_js.js";

export interface WasmerOptions {
  outputBytes?: number;
  wasm?: Parameters<typeof init>[0];
}

export type PackageSource = string | Uint8Array | Package;
export type CommandSelector = string | Package;
export type FileContents = string | Uint8Array;

export interface SandboxOptions {
  packages?: PackageSource[];
  files?: Record<string, FileContents>;
  network?: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string | Uint8Array;
  outputBytes?: number;
}

export interface RunOptions {
  check?: boolean;
}

let browserInitialization: Promise<void> | undefined;

export class Wasmer {
  readonly #options: WasmerOptions;
  #core: Promise<WasmerCore> | undefined;

  constructor(options: WasmerOptions = {}) {
    this.#options = options;
  }

  /**
   * Compatibility factory for callers that want initialization errors before
   * receiving the client. New code should prefer `new Wasmer(options)`.
   */
  static async create<T extends Wasmer>(
    this: new (options?: WasmerOptions) => T,
    options: WasmerOptions = {},
  ): Promise<T> {
    const wasmer = new this(options);
    await wasmer.ready();
    return wasmer;
  }

  protected static async initializeCore(
    options: WasmerOptions,
  ): Promise<WasmerCore> {
    browserInitialization ??= init(
      options.wasm === undefined
        ? undefined
        : { module_or_path: options.wasm as never },
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        browserInitialization = undefined;
        throw error;
      });
    await browserInitialization;
    return WasmerCore.create({ outputBytes: options.outputBytes });
  }

  /** Wait for the target runtime to finish initializing. */
  async ready(): Promise<this> {
    await this.getCore();
    return this;
  }

  /** Resolve a registry package or decode in-memory WEBC bytes. */
  async loadPackage(source: string | Uint8Array): Promise<Package> {
    const client = await this.getCore();
    const core =
      typeof source === "string"
        ? await client.loadPackage(source)
        : await client.loadPackageBytes(source);
    return new Package(core);
  }

  async createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
    const client = await this.getCore();
    const builder = client.sandbox();
    for (const source of options.packages ?? []) {
      const pkg = source instanceof Package ? source : await this.loadPackage(source);
      builder.package(pkg.core);
    }
    for (const [path, contents] of Object.entries(options.files ?? {})) {
      builder.file(path, encode(contents));
    }
    builder.network(options.network ?? false);
    return new Sandbox(this, await builder.start());
  }

  async shutdown(): Promise<void> {
    if (!this.#core) return;
    const client = await this.#core;
    await client.shutdown();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private getCore(): Promise<WasmerCore> {
    const implementation = this.constructor as typeof Wasmer;
    return (this.#core ??= implementation.initializeCore(this.#options));
  }
}

export class Package {
  constructor(readonly core: PackageCore) {}

  get id(): string {
    return this.core.id;
  }

  get commands(): readonly string[] {
    return this.core.commands;
  }
}

export class Sandbox {
  readonly fs: SandboxFileSystem;

  constructor(
    readonly wasmer: Wasmer,
    readonly core: SandboxCore,
  ) {
    this.fs = new SandboxFileSystem(core);
  }

  command(
    selector: CommandSelector,
    args: readonly string[] = [],
    options: CommandOptions = {},
  ): Command {
    const core =
      selector instanceof Package
        ? this.core.commandPackage(selector.core)
        : this.core.command(selector);
    core.args([...args]);
    applyCommandOptions(core, options);
    return new Command(core);
  }

  shell(script: string, options: CommandOptions = {}): Command {
    return this.command("sh", ["-c", script], options);
  }

  sh(strings: TemplateStringsArray, ...values: unknown[]): Command {
    let script = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) {
      script += shellEscape(String(values[index])) + (strings[index + 1] ?? "");
    }
    return this.shell(script);
  }

  async installPackage(source: string | Uint8Array): Promise<Package> {
    const core =
      typeof source === "string"
        ? await this.core.installPackage(source)
        : await this.core.installPackageBytes(source);
    return new Package(core);
  }

  async close(): Promise<void> {
    await this.core.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export class Command {
  constructor(readonly core: CommandCore) {}

  async run(options: RunOptions = {}): Promise<Output> {
    const output = Output.fromCore(await this.core.run());
    if (options.check && !output.success) throw new ProcessExitError(output);
    return output;
  }

  async spawn(): Promise<Process> {
    return new Process(await this.core.spawn());
  }
}

export class CapturedOutput {
  constructor(
    readonly bytes: Uint8Array,
    readonly truncated: boolean,
  ) {}

  text(): string {
    return new TextDecoder().decode(this.bytes);
  }
}

export class Output {
  constructor(
    readonly code: number,
    readonly stdout: CapturedOutput,
    readonly stderr: CapturedOutput,
  ) {}

  static fromCore(core: {
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }): Output {
    return new Output(
      core.code,
      new CapturedOutput(core.stdout, core.stdoutTruncated),
      new CapturedOutput(core.stderr, core.stderrTruncated),
    );
  }

  get success(): boolean {
    return this.code === 0;
  }

  text(): string {
    this.check();
    return this.stdout.text();
  }

  check(): this {
    if (!this.success) throw new ProcessExitError(this);
    return this;
  }
}

export class ProcessExitError extends Error {
  constructor(readonly output: Output) {
    super(`process exited unsuccessfully with status ${output.code}`);
    this.name = "ProcessExitError";
  }
}

export class Process {
  readonly stdin: ProcessStdin;
  readonly stdout: ProcessOutputStream;
  readonly stderr: ProcessOutputStream;

  constructor(readonly core: ProcessCore) {
    this.stdin = new ProcessStdin(core);
    this.stdout = new ProcessOutputStream((size) => core.readStdout(size));
    this.stderr = new ProcessOutputStream((size) => core.readStderr(size));
  }

  get id(): number {
    return this.core.id;
  }

  async wait(options: RunOptions = {}): Promise<Output> {
    const output = Output.fromCore(await this.core.wait());
    if (options.check && !output.success) throw new ProcessExitError(output);
    return output;
  }

  async terminate(options: { graceMs?: number } = {}): Promise<void> {
    await this.core.terminate(options.graceMs ?? 1_000);
  }

  async kill(): Promise<void> {
    await this.core.kill();
  }
}

export class ProcessStdin {
  constructor(readonly core: ProcessCore) {}

  async write(value: string | Uint8Array): Promise<void> {
    await this.core.writeStdin(encode(value));
  }

  async close(): Promise<void> {
    await this.core.closeStdin();
  }
}

export class ProcessOutputStream implements AsyncIterable<Uint8Array> {
  readonly #read: (size: number) => Promise<Uint8Array | null>;

  constructor(read: (size: number) => Promise<Uint8Array | null>) {
    this.#read = read;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await this.#read(64 * 1024);
      if (chunk === null) return;
      yield chunk;
    }
  }

  async *lines(): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of this) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      yield* lines;
    }
    pending += decoder.decode();
    if (pending) yield pending;
  }

  toReadableStream(): ReadableStream<Uint8Array> {
    const iterator = this[Symbol.asyncIterator]();
    return new ReadableStream({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
  }
}

export class SandboxFileSystem {
  constructor(readonly core: SandboxCore) {}

  async writeFile(path: string, contents: FileContents): Promise<void> {
    await this.core.writeFile(path, encode(contents));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.core.readFile(path);
  }

  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }
}

function applyCommandOptions(core: CommandCore, options: CommandOptions): void {
  if (options.cwd) core.currentDir(options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) core.env(key, value);
  if (options.input !== undefined) core.input(encode(options.input));
  if (options.outputBytes !== undefined) core.outputBytes(options.outputBytes);
}

function encode(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
