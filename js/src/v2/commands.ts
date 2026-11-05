import type { CommandCore, OutputCore, PackageCore, ProcessCore, SandboxCore } from "../core.js";
import { LiveDirectory } from "./raw-core.js";
import { coreError, V2Package, V2Packages } from "./packages.js";

type OutputMode = "pipe" | "capture" | "discard";
export interface PackageCommandPlan {
  selected: V2Package;
  command: string;
  /** Selected package first; remaining installed packages keep their order. */
  packages: readonly V2Package[];
  workspace: LiveDirectory;
  mounts: Readonly<Record<string, LiveDirectory>>;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  outputBytes: number;
  timeoutMs: number | undefined;
  terminal: { columns: number; rows: number } | undefined;
  stdin: "pipe" | "closed";
  stdout: OutputMode;
  stderr: OutputMode;
}

/** Actual process/I/O policy is supplied by the v2 execution binding, never v1. */
export interface PackageExecution {
  spawn(plan: PackageCommandPlan): Promise<ProcessCore>;
  run(plan: PackageCommandPlan, input: Uint8Array<ArrayBuffer>): Promise<OutputCore>;
}

export class V2Command implements CommandCore {
  readonly #args: string[] = [];
  readonly #env: Record<string, string> = {};
  #cwd = "/workspace";
  #input = new Uint8Array();
  #outputBytes: number;
  #timeoutMs: number | undefined;
  #terminal: { columns: number; rows: number } | undefined;
  #stdin: "pipe" | "closed" = "closed";
  #stdout: OutputMode = "pipe";
  #stderr: OutputMode = "pipe";
  #consumed = false;

  constructor(private readonly resolve: () => Omit<PackageCommandPlan,
    "args" | "cwd" | "outputBytes" | "timeoutMs" | "terminal" | "stdin" | "stdout" | "stderr">,
    private readonly execution: PackageExecution, outputBytes: number) {
    this.#outputBytes = outputBytes;
  }

  args(args: string[]): void { this.#mutable(); this.#args.push(...args); }
  env(key: string, value: string): void { this.#mutable(); this.#env[key] = value; }
  currentDir(path: string): void { this.#mutable(); this.#cwd = path; }
  input(bytes: Uint8Array): void { this.#mutable(); this.#input = new Uint8Array(bytes); }
  outputBytes(bytes: number): void { this.#mutable(); this.#outputBytes = integer(bytes, "outputBytes", 0, 0xffff_ffff); }
  timeoutMs(milliseconds: number): void { this.#mutable(); this.#timeoutMs = integer(milliseconds, "timeoutMs", 0, Number.MAX_SAFE_INTEGER); }
  terminal(columns: number, rows: number): void {
    this.#mutable();
    this.#terminal = { columns: integer(columns, "terminal.columns", 1, 0xffff_ffff), rows: integer(rows, "terminal.rows", 1, 0xffff_ffff) };
  }
  stdinMode(mode: string): void {
    this.#mutable();
    if (mode !== "pipe" && mode !== "closed") throw coreError("INVALID_ARGUMENT", `invalid stdio mode \`${mode}\``);
    this.#stdin = mode;
  }
  stdoutMode(mode: string): void { this.#mutable(); this.#stdout = outputMode(mode); }
  stderrMode(mode: string): void { this.#mutable(); this.#stderr = outputMode(mode); }

  run(): Promise<OutputCore> {
    return this.execution.run(this.#plan(this.#input.length ? "pipe" : "closed", "capture", "capture"), this.#input);
  }
  spawn(): Promise<ProcessCore> { return this.execution.spawn(this.#plan(this.#stdin, this.#stdout, this.#stderr)); }

  #plan(stdin: "pipe" | "closed", stdout: OutputMode, stderr: OutputMode): PackageCommandPlan {
    this.#mutable();
    this.#consumed = true;
    const resolved = this.resolve();
    return { ...resolved, args: [...this.#args], env: { ...resolved.env, ...this.#env }, cwd: this.#cwd,
      outputBytes: this.#outputBytes, timeoutMs: this.#timeoutMs, terminal: this.#terminal && { ...this.#terminal },
      stdin: this.#terminal ? "pipe" : stdin, stdout: this.#terminal ? "pipe" : stdout, stderr: this.#terminal ? "pipe" : stderr };
  }
  #mutable(): void { if (this.#consumed) throw coreError("INVALID_ARGUMENT", "command has already been consumed"); }
}

type Selector = { kind: "name"; name: string } | { kind: "package"; package: V2Package } | { kind: "ref"; package: V2Package; name: string };

/** Package/command facet composed into the public SandboxCore alongside fs/net. */
export class V2SandboxPackages implements Pick<SandboxCore, "command" | "commandPackage" | "commandRef" | "installPackageRef"> {
  readonly #installed: V2Package[] = [];
  readonly #environment: Readonly<Record<string, string>>;
  readonly #mounts: Readonly<Record<string, LiveDirectory>>;
  #closed = false;

  constructor(private readonly loader: V2Packages, readonly workspace: LiveDirectory,
    private readonly execution: PackageExecution, private readonly outputBytes: number,
    environment: Readonly<Record<string, string>> = {},
    mounts: Readonly<Record<string, LiveDirectory>> = {}) {
    this.#environment = { ...environment };
    this.#mounts = { ...mounts };
  }

  command(name: string): CommandCore { return this.#command({ kind: "name", name }); }
  commandPackage(pkg: PackageCore): CommandCore { return this.#command({ kind: "package", package: this.loader.requirePackage(pkg) }); }
  commandRef(pkg: PackageCore, name: string): CommandCore {
    const requested = this.loader.requirePackage(pkg);
    if (!requested.hasCommand(name)) throw coreError("COMMAND_NOT_FOUND", `package \`${requested.id}\` does not export the command \`${name}\``);
    return this.#command({ kind: "ref", package: requested, name });
  }

  async installPackageRef(pkg: PackageCore): Promise<V2Package> {
    this.#open();
    const imported = await this.loader.importPackage(pkg);
    this.#open();
    if (!this.#installed.some(candidate => candidate.id === imported.id)) this.#installed.push(imported);
    return imported;
  }

  markClosed(): void { this.#closed = true; }

  #command(selector: Selector): CommandCore {
    return new V2Command(() => this.#resolve(selector), this.execution, this.outputBytes);
  }

  #resolve(selector: Selector): Omit<PackageCommandPlan,
    "args" | "cwd" | "outputBytes" | "timeoutMs" | "terminal" | "stdin" | "stdout" | "stderr"> {
    this.#open();
    let selected: V2Package, command: string;
    if (selector.kind === "name") {
      const matches = this.#installed.filter(pkg => pkg.hasCommand(selector.name));
      if (matches.length === 0) throw coreError("COMMAND_NOT_FOUND", `command \`${selector.name}\` was not found in the installed packages`);
      if (matches.length > 1) throw coreError("COMMAND_AMBIGUOUS", `command \`${selector.name}\` is ambiguous; it is provided by ${JSON.stringify(matches.map(pkg => pkg.id))}`);
      selected = matches[0]!;
      command = selector.name;
    } else {
      const installed = this.#installed.find(pkg => pkg.id === selector.package.id);
      if (!installed) throw coreError("PACKAGE_NOT_INSTALLED", `package \`${selector.package.id}\` is not installed in this sandbox`);
      selected = installed;
      const name = selector.kind === "ref" ? selector.name : selected.entrypoint;
      if (name === undefined) throw coreError("PACKAGE_HAS_NO_ENTRYPOINT", `package \`${selected.id}\` has no unambiguous entrypoint`);
      command = name;
    }
    return { selected, command, packages: [selected, ...this.#installed.filter(pkg => pkg.id !== selected.id)],
      workspace: this.workspace, mounts: this.#mounts, env: this.#environment };
  }
  #open(): void { if (this.#closed) throw coreError("SANDBOX_CLOSED", "the sandbox is closed"); }
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw coreError("INVALID_ARGUMENT", `${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function outputMode(value: string): OutputMode {
  if (value !== "pipe" && value !== "capture" && value !== "discard") throw coreError("INVALID_ARGUMENT", `invalid stdio mode \`${value}\``);
  return value;
}
