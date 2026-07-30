import init, {
  setSDKUrl,
  WasmerCore,
  type CommandCore,
  type PackageCore,
  type ProcessCore,
  type SandboxCore,
} from "../pkg/wasmer_sdk_js.js";

export interface WasmerOptions {
  outputBytes?: number;
  wasm?: Parameters<typeof init>[0];
  /**
   * Persistent package and registry caching. Browsers use an origin-scoped
   * cache namespace; Node uses `directory`, which defaults to `.wasmer`.
   */
  cache?: false | "memory" | CacheOptions;
}

export interface CacheOptions {
  /** Node-only cache root, resolved when the client is created. */
  directory?: string;
  /** Logical browser cache namespace. */
  namespace?: string;
  /** Read existing entries without writing new ones. */
  readOnly?: boolean;
}

export type PackageSource = string | Uint8Array | Package;
export type CommandSelector = string | Package | CommandRef;
export type FileContents = string | Uint8Array;

export type NetworkPolicy = { mode: "disabled" } | { mode: "host" };

export interface SandboxOptions {
  packages?: readonly PackageSource[];
  files?: Readonly<Record<string, FileContents>>;
  env?: Readonly<Record<string, string>>;
  network?: NetworkPolicy;
  /** The command used by `sandbox.shell()` and `sandbox.sh`. */
  shell?: CommandSelector;
}

export interface Packages {
  /** Resolve a registry package or decode in-memory WEBC bytes. */
  load(source: string | Uint8Array): Promise<Package>;
}

export interface Sandboxes {
  create(options?: SandboxOptions): Promise<Sandbox>;
}

export interface InstallPackageOptions {
  /** Select one command exported by this package as the sandbox's shell. */
  asShell?: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  outputBytes?: number;
  check?: boolean;
}

export type OutputMode = "pipe" | "capture" | "discard";

export interface SpawnOptions {
  timeoutMs?: number;
  outputBytes?: number;
  stdin?: "pipe" | "closed";
  stdout?: OutputMode;
  stderr?: OutputMode;
}

export type ExitReason = "exited" | "terminated" | "timeout";

export interface FileStat {
  kind: "file" | "directory";
  size: number;
}

export interface DirectoryEntry extends FileStat {
  name: string;
}

export type WasmerErrorCode =
  | "CLIENT_CLOSED"
  | "SANDBOX_CLOSED"
  | "INVALID_ARGUMENT"
  | "INVALID_PACKAGE_SOURCE"
  | "PACKAGE_NOT_FOUND"
  | "PACKAGE_LOAD_FAILED"
  | "PACKAGE_NOT_INSTALLED"
  | "PACKAGE_HAS_NO_ENTRYPOINT"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_AMBIGUOUS"
  | "SHELL_NOT_CONFIGURED"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_PATH"
  | "FILESYSTEM_ERROR"
  | "TIMEOUT"
  | "PROCESS_EXITED"
  | "PROCESS_TERMINATED"
  | "INVALID_UTF8"
  | "EXECUTION_ERROR"
  | "TASK_ERROR"
  | "INTERNAL_ERROR"
  | "IO_ERROR"
  | "INITIALIZATION_ERROR"
  | "TARGET_ERROR";

/** An SDK failure with a machine-readable, currently provisional `code`. */
export class WasmerError extends Error {
  constructor(
    message: string,
    readonly code: WasmerErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WasmerError";
  }

  static is(error: unknown, code?: WasmerErrorCode): error is WasmerError {
    return (
      error instanceof WasmerError && (code === undefined || error.code === code)
    );
  }
}

/** A checked command completed unsuccessfully; `output` holds the details. */
export class ProcessExitError extends Error {
  constructor(readonly output: Output) {
    super(describeExit(output));
    this.name = "ProcessExitError";
  }

  get code(): "PROCESS_EXITED" | "PROCESS_TERMINATED" | "TIMEOUT" {
    switch (this.output.reason) {
      case "terminated":
        return "PROCESS_TERMINATED";
      case "timeout":
        return "TIMEOUT";
      default:
        return "PROCESS_EXITED";
    }
  }
}

const STDERR_EXCERPT_BYTES = 512;

function describeExit(output: Output): string {
  let base: string;
  switch (output.reason) {
    case "terminated":
      base = "process was terminated before completing";
      break;
    case "timeout":
      base = "process timed out";
      break;
    default:
      base = `process exited unsuccessfully with status ${output.exitCode}`;
  }
  const stderr = output.stderr.bytes;
  const start = Math.max(0, stderr.length - STDERR_EXCERPT_BYTES);
  const excerpt = new TextDecoder().decode(stderr.subarray(start)).trim();
  if (!excerpt) return base;
  return `${base}\nstderr: ${start > 0 ? "…" : ""}${excerpt}`;
}

/** Rewrap errors thrown by the wasm core into `WasmerError`. */
async function rethrow<T>(work: Promise<T> | T): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw toWasmerError(error);
  }
}

function toWasmerError(error: unknown): unknown {
  if (
    error instanceof Error &&
    !(error instanceof WasmerError) &&
    error.name === "WasmerError"
  ) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      return new WasmerError(error.message, code as WasmerErrorCode, {
        cause: error,
      });
    }
  }
  return error;
}

const packageCores = new WeakMap<Package, PackageCore>();

let browserInitialization: Promise<void> | undefined;
const MAX_WASM32_SIZE = 0xffff_ffff;

export class Wasmer {
  /** Package acquisition operations for this client. */
  readonly packages: Packages;
  /** Sandbox creation operations for this client. */
  readonly sandboxes: Sandboxes;
  readonly #options: WasmerOptions;
  #core: Promise<WasmerCore> | undefined;

  constructor(options: WasmerOptions = {}) {
    this.#options = {
      ...options,
      outputBytes:
        options.outputBytes === undefined
          ? undefined
          : validateOutputBytes(options.outputBytes),
    };
    this.packages = new PackagesService((source) => this.#loadPackage(source));
    this.sandboxes = new SandboxesService((options) =>
      this.#createSandbox(options),
    );
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

  /** Target-specific initialization; the Node entrypoint overrides this. */
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
    setSDKUrl(new URL("../pkg/wasmer_sdk_js.js", import.meta.url).href);
    return WasmerCore.create({
      outputBytes: options.outputBytes,
      cache: browserCacheOptions(options.cache),
    });
  }

  /** Wait for the target runtime to finish initializing. */
  async ready(): Promise<this> {
    await this.getCore();
    return this;
  }

  /**
   * Resolve a registry package or decode in-memory WEBC bytes.
   * @deprecated Use `wasmer.packages.load(source)`.
   */
  async loadPackage(source: string | Uint8Array): Promise<Package> {
    return this.packages.load(source);
  }

  /** @deprecated Use `wasmer.sandboxes.create(options)`. */
  async createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
    return this.sandboxes.create(options);
  }

  async #loadPackage(source: string | Uint8Array): Promise<Package> {
    const client = await this.getCore();
    const core = await rethrow(
      typeof source === "string"
        ? client.loadPackage(source)
        : client.loadPackageBytes(source),
    );
    return new Package(core);
  }

  async #createSandbox(options: SandboxOptions): Promise<Sandbox> {
    const client = await this.getCore();
    const packages = await Promise.all(
      (options.packages ?? []).map((source) =>
        source instanceof Package ? source : this.packages.load(source),
      ),
    );
    const builder = client.sandbox();
    for (const pkg of packages) {
      builder.package(packageCores.get(pkg)!);
    }
    for (const [path, contents] of Object.entries(options.files ?? {})) {
      builder.file(path, encode(contents));
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      builder.env(key, value);
    }
    builder.network((options.network ?? { mode: "disabled" }).mode);
    const core = await rethrow(builder.start());
    return new Sandbox(this, core, options.shell);
  }

  /** Close the client and release its workers and runtime resources. */
  async close(): Promise<void> {
    if (!this.#core) return;
    const client = await this.#core;
    await this.closeCore(client);
  }

  /** @deprecated Use {@link Wasmer.close}. */
  async shutdown(): Promise<void> {
    await this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  protected async closeCore(client: WasmerCore): Promise<void> {
    await rethrow(client.shutdown());
  }

  private getCore(): Promise<WasmerCore> {
    const implementation = this.constructor as typeof Wasmer;
    return rethrow((this.#core ??= implementation.initializeCore(this.#options)));
  }
}

function browserCacheOptions(
  cache: WasmerOptions["cache"],
): { mode: string; namespace?: string; readOnly?: boolean } {
  if (cache === false) return { mode: "disabled" };
  if (cache === "memory") return { mode: "memory" };
  if (cache?.directory !== undefined) {
    throw new WasmerError(
      "`cache.directory` is only available from the Node entrypoint",
      "INVALID_ARGUMENT",
    );
  }
  return {
    mode: "browser",
    namespace: cache?.namespace,
    readOnly: cache?.readOnly,
  };
}

class PackagesService implements Packages {
  readonly #load: (source: string | Uint8Array) => Promise<Package>;

  constructor(load: (source: string | Uint8Array) => Promise<Package>) {
    this.#load = load;
  }

  /** Resolve a registry package or decode in-memory WEBC bytes. */
  load(source: string | Uint8Array): Promise<Package> {
    return this.#load(source);
  }
}

class SandboxesService implements Sandboxes {
  readonly #create: (options: SandboxOptions) => Promise<Sandbox>;

  constructor(create: (options: SandboxOptions) => Promise<Sandbox>) {
    this.#create = create;
  }

  create(options: SandboxOptions = {}): Promise<Sandbox> {
    return this.#create(options);
  }
}

export class Package {
  constructor(core: PackageCore) {
    packageCores.set(this, core);
  }

  get id(): string {
    return packageCores.get(this)!.id;
  }

  get commands(): readonly string[] {
    return packageCores.get(this)!.commands;
  }

  /** The command run when this package is used directly as a selector. */
  get entrypoint(): string | undefined {
    return packageCores.get(this)!.entrypoint ?? undefined;
  }

  /**
   * Select a named command from this package, resolving name collisions
   * between installed packages.
   */
  command(name: string): CommandRef {
    if (!packageCores.get(this)!.hasCommand(name)) {
      throw new WasmerError(
        `package \`${this.id}\` does not export the command \`${name}\``,
        "COMMAND_NOT_FOUND",
      );
    }
    return new CommandRef(this, name);
  }
}

/** A command explicitly qualified by its package. */
export class CommandRef {
  constructor(
    readonly pkg: Package,
    readonly name: string,
  ) {}
}

export type ShellValue =
  | string
  | number
  | URL
  | readonly (string | number | URL)[];

export class Sandbox {
  readonly fs: SandboxFileSystem;
  readonly ports: Ports;
  readonly #core: SandboxCore;
  #shell: CommandSelector | undefined;

  constructor(
    readonly wasmer: Wasmer,
    core: SandboxCore,
    shell?: CommandSelector,
  ) {
    this.#core = core;
    this.fs = new SandboxFileSystem(core);
    this.ports = new Ports(core);
    this.#shell = shell;
  }

  command(
    selector: CommandSelector,
    args: readonly string[] | CommandOptions = [],
    options: CommandOptions = {},
  ): Command {
    if (!Array.isArray(args)) {
      options = args as CommandOptions;
      args = [];
    }
    const argv = [...(args as readonly string[])];
    const settings = { ...options };
    const core = this.#core;
    return new Command(() => {
      let command: CommandCore;
      if (selector instanceof CommandRef) {
        command = core.commandRef(packageCores.get(selector.pkg)!, selector.name);
      } else if (selector instanceof Package) {
        command = core.commandPackage(packageCores.get(selector)!);
      } else {
        command = core.command(selector);
      }
      command.args(argv);
      if (settings.cwd) command.currentDir(settings.cwd);
      for (const [key, value] of Object.entries(settings.env ?? {})) {
        command.env(key, value);
      }
      return command;
    });
  }

  /**
   * Build a command that runs `script` through the sandbox's configured
   * shell. Configure one with `SandboxOptions.shell` or
   * `installPackage(source, { asShell })`.
   */
  shell(script: string, options: CommandOptions = {}): Command {
    return this.command(this.#requireShell(), ["-c", script], options);
  }

  /**
   * Tagged-template shell: interpolated values are escaped as argument data,
   * and an interpolated array expands to individually escaped arguments.
   */
  sh(strings: TemplateStringsArray, ...values: readonly ShellValue[]): Command {
    let script = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) {
      script += escapeShellValue(values[index]!) + (strings[index + 1] ?? "");
    }
    return this.shell(script);
  }

  async installPackage(
    source: PackageSource,
    options: InstallPackageOptions = {},
  ): Promise<Package> {
    let core: PackageCore;
    if (source instanceof Package) {
      core = await rethrow(
        this.#core.installPackageRef(packageCores.get(source)!),
      );
    } else if (typeof source === "string") {
      core = await rethrow(this.#core.installPackage(source));
    } else {
      core = await rethrow(this.#core.installPackageBytes(source));
    }
    const pkg = new Package(core);
    if (options.asShell !== undefined) {
      this.#shell = pkg.command(options.asShell);
    }
    return pkg;
  }

  async close(): Promise<void> {
    await rethrow(this.#core.close());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #requireShell(): CommandSelector {
    if (this.#shell === undefined) {
      throw new WasmerError(
        "no shell is configured for this sandbox; install a shell-providing " +
          "package and select it with `SandboxOptions.shell` or " +
          "`installPackage(source, { asShell })`",
        "SHELL_NOT_CONFIGURED",
      );
    }
    return this.#shell;
  }
}

/** Guest port facilities for one sandbox. */
export class Ports {
  readonly #core: SandboxCore;

  constructor(core: SandboxCore) {
    this.#core = core;
  }

  /**
   * Wait until a guest TCP listener accepts connections on `port`.
   *
   * The probe uses the sandbox's own network policy: it observes exactly
   * what the guest exposed, and fails with `CAPABILITY_UNAVAILABLE` when
   * networking is disabled.
   *
   * A successful probe opens and immediately closes one real TCP connection.
   * Use an application-level readiness signal for one-shot or
   * connection-count-sensitive servers.
   */
  async wait(
    port: number,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const validPort = validateInteger("port", port, 1, 65_535);
    const timeoutMs = validateTimeoutMs(options.timeoutMs ?? 30_000);
    await rethrow(this.#core.waitForPort(validPort, timeoutMs));
  }
}

/**
 * A reusable, immutable execution description. Each `run()` or `spawn()`
 * starts an independent process.
 */
export class Command {
  readonly #build: () => CommandCore;

  constructor(build: () => CommandCore) {
    this.#build = build;
  }

  async run(options: RunOptions = {}): Promise<Output> {
    const timeoutMs =
      options.timeoutMs === undefined
        ? undefined
        : validateTimeoutMs(options.timeoutMs);
    const outputBytes =
      options.outputBytes === undefined
        ? undefined
        : validateOutputBytes(options.outputBytes);
    const core = this.#build();
    if (timeoutMs !== undefined) core.timeoutMs(timeoutMs);
    if (outputBytes !== undefined) core.outputBytes(outputBytes);
    if (options.stdin !== undefined) core.input(encode(options.stdin));
    const output = Output.fromCore(await rethrow(core.run()));
    if (options.check && !output.ok) throw new ProcessExitError(output);
    return output;
  }

  async spawn(options: SpawnOptions = {}): Promise<Process> {
    const timeoutMs =
      options.timeoutMs === undefined
        ? undefined
        : validateTimeoutMs(options.timeoutMs);
    const outputBytes =
      options.outputBytes === undefined
        ? undefined
        : validateOutputBytes(options.outputBytes);
    const core = this.#build();
    if (timeoutMs !== undefined) core.timeoutMs(timeoutMs);
    if (outputBytes !== undefined) core.outputBytes(outputBytes);
    const stdin = options.stdin ?? "closed";
    const stdout = options.stdout ?? "pipe";
    const stderr = options.stderr ?? "pipe";
    core.stdinMode(stdin);
    core.stdoutMode(stdout);
    core.stderrMode(stderr);
    const process = await rethrow(core.spawn());
    return new Process(process, {
      stdin: stdin === "pipe",
      stdout: stdout === "pipe",
      stderr: stderr === "pipe",
    });
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
    readonly exitCode: number,
    readonly reason: ExitReason,
    readonly stdout: CapturedOutput,
    readonly stderr: CapturedOutput,
  ) {}

  static fromCore(core: {
    exitCode: number;
    reason: string;
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }): Output {
    return new Output(
      core.exitCode,
      core.reason as ExitReason,
      new CapturedOutput(core.stdout, core.stdoutTruncated),
      new CapturedOutput(core.stderr, core.stderrTruncated),
    );
  }

  /** True only when the guest exited on its own with a zero status. */
  get ok(): boolean {
    return this.reason === "exited" && this.exitCode === 0;
  }

  /** Check success and decode stdout. */
  text(): string {
    this.check();
    return this.stdout.text();
  }

  check(): this {
    if (!this.ok) throw new ProcessExitError(this);
    return this;
  }
}

export class Process {
  readonly stdin: WritableBytes | null;
  readonly stdout: ReadableBytes | null;
  readonly stderr: ReadableBytes | null;
  readonly #core: ProcessCore;

  constructor(
    core: ProcessCore,
    streams: { stdin: boolean; stdout: boolean; stderr: boolean },
  ) {
    this.#core = core;
    this.stdin = streams.stdin ? new WritableBytes(core) : null;
    this.stdout = streams.stdout
      ? new ReadableBytes((size) => core.readStdout(size))
      : null;
    this.stderr = streams.stderr
      ? new ReadableBytes((size) => core.readStderr(size))
      : null;
  }

  get id(): number {
    return this.#core.id;
  }

  async wait(options: { check?: boolean } = {}): Promise<Output> {
    const output = Output.fromCore(await rethrow(this.#core.wait()));
    if (options.check && !output.ok) throw new ProcessExitError(output);
    return output;
  }

  /** Ask the guest to exit; escalate to a forced kill after the grace period. */
  async terminate(options: { gracePeriodMs?: number } = {}): Promise<void> {
    const gracePeriodMs = validateTimeoutMs(
      options.gracePeriodMs ?? 1_000,
      "gracePeriodMs",
    );
    await rethrow(this.#core.terminate(gracePeriodMs));
  }

  /** Immediate forced termination. */
  async kill(): Promise<void> {
    this.#core.kill();
  }
}

/** Writable guest stdin. Closing it sends EOF; it does not kill the process. */
export class WritableBytes {
  readonly #core: ProcessCore;

  constructor(core: ProcessCore) {
    this.#core = core;
  }

  async write(data: string | Uint8Array): Promise<void> {
    await rethrow(this.#core.writeStdin(encode(data)));
  }

  async close(): Promise<void> {
    await rethrow(this.#core.closeStdin());
  }

  toWritableStream(): WritableStream<Uint8Array> {
    return new WritableStream({
      write: (chunk) => this.write(chunk),
      close: () => this.close(),
      abort: () => this.close(),
    });
  }
}

/** A readable byte stream with guaranteed async iteration. */
export class ReadableBytes implements AsyncIterable<Uint8Array> {
  readonly #read: (size: number) => Promise<Uint8Array | null>;

  constructor(read: (size: number) => Promise<Uint8Array | null>) {
    this.#read = read;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await rethrow(this.#read(64 * 1024));
      if (chunk === null) return;
      yield chunk;
    }
  }

  /** Incrementally decoded lines; never assumes one chunk is one line. */
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
  readonly #core: SandboxCore;

  constructor(core: SandboxCore) {
    this.#core = core;
  }

  async writeFile(path: string, contents: FileContents): Promise<void> {
    await rethrow(this.#core.writeFile(path, encode(contents)));
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.writeFile(path, text);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return rethrow(this.#core.readFile(path));
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    await rethrow(this.#core.mkdir(path, options.recursive ?? false));
  }

  async readDir(path: string): Promise<readonly DirectoryEntry[]> {
    return rethrow(
      this.#core.readDir(path) as Promise<readonly DirectoryEntry[]>,
    );
  }

  async stat(path: string): Promise<FileStat> {
    return rethrow(this.#core.stat(path) as Promise<FileStat>);
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    await rethrow(this.#core.remove(path, options.recursive ?? false));
  }

  async rename(from: string, to: string): Promise<void> {
    await rethrow(this.#core.rename(from, to));
  }
}

function encode(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function validateTimeoutMs(value: number, name = "timeoutMs"): number {
  return validateInteger(name, value, 0, Number.MAX_SAFE_INTEGER);
}

function validateOutputBytes(value: number): number {
  return validateInteger("outputBytes", value, 0, MAX_WASM32_SIZE);
}

function validateInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new WasmerError(
      `\`${name}\` must be an integer between ${minimum} and ${maximum}, inclusive`,
      "INVALID_ARGUMENT",
    );
  }
  return value;
}

function escapeShellValue(value: ShellValue): string {
  if (Array.isArray(value)) {
    return value.map((entry) => escapeShellWord(String(entry))).join(" ");
  }
  return escapeShellWord(String(value));
}

function escapeShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
