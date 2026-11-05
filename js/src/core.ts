import type {
  DirectoryEntry,
  FileStat,
  PackageDefinition,
  PackageLoadProgress,
} from "./index.js";

// The handwritten API depends on this seam, not wasm-bindgen object ownership.
// Browser v2 and the existing target adapters implement the same contracts.
export interface PackageLoadCancellationCore {
  cancel(): void;
  free(): void;
}

export interface WasmerCore {
  createPackage(definition: PackageDefinition): Promise<PackageCore>;
  loadPackages(
    sources: (string | Uint8Array)[],
    onProgress: ((progress: PackageLoadProgress) => void) | undefined,
    cancellation: PackageLoadCancellationCore,
  ): Promise<PackageCore[]>;
  sandbox(): SandboxBuilderCore;
  shutdown(): Promise<void>;
}

export interface PackageCore {
  readonly id: string;
  readonly commands: string[];
  readonly entrypoint: string | undefined;
  hasCommand(name: string): boolean;
}

export interface SandboxBuilderCore {
  package(pkg: PackageCore): void;
  file(path: string, bytes: Uint8Array): void;
  env(key: string, value: string): void;
  network(mode: string): void;
  networkWisp(bridge: object): void;
  restrictNetworkPeers(): void;
  addNetworkPeer(peer: SandboxCore): void;
  start(): Promise<SandboxCore>;
}

export interface SandboxCore {
  command(name: string): CommandCore;
  commandPackage(pkg: PackageCore): CommandCore;
  commandRef(pkg: PackageCore, name: string): CommandCore;
  installPackageRef(pkg: PackageCore): Promise<PackageCore>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, recursive: boolean): void | Promise<void>;
  readDir(path: string): DirectoryEntry[] | Promise<DirectoryEntry[]>;
  stat(path: string): FileStat | Promise<FileStat>;
  remove(path: string, recursive: boolean): void | Promise<void>;
  rename(from: string, to: string): Promise<void>;
  waitForPort(port: number, timeoutMs: number): Promise<void>;
  isHttpPortListening(port: number): boolean;
  httpListeningPorts(): Uint16Array | undefined;
  handleHttpRequest(
    port: number,
    method: string,
    path: string,
    headers: [string, string][],
    body: Uint8Array,
  ): Promise<HttpResponseCore>;
  close(): Promise<void>;
}

export interface HttpResponseCore {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
}

export interface CommandCore {
  args(args: string[]): void;
  env(key: string, value: string): void;
  currentDir(path: string): void;
  input(bytes: Uint8Array): void;
  outputBytes(bytes: number): void;
  timeoutMs(milliseconds: number): void;
  terminal(columns: number, rows: number): void;
  stdinMode(mode: string): void;
  stdoutMode(mode: string): void;
  stderrMode(mode: string): void;
  run(): Promise<OutputCore>;
  spawn(): Promise<ProcessCore>;
}

export interface OutputCore {
  readonly exitCode: number;
  readonly reason: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessCore {
  readonly id: number;
  writeStdin(bytes: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  readStdout(maxBytes: number): Promise<Uint8Array | null>;
  readStderr(maxBytes: number): Promise<Uint8Array | null>;
  wait(): Promise<OutputCore>;
  terminate(graceMs: number): Promise<void>;
  kill(): void;
  resizeTerminal(columns: number, rows: number): void;
}
