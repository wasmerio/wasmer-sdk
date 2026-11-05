import type { PackageCore, WasmerCore } from "../core.js";
import type { PackageDefinition } from "../api-types.js";
import { BrowserRuntime } from "./runtime.js";

interface PackageMetadata {
  handle: number;
  id: string;
  commands: string[];
  entrypoint: string | null;
}
interface CoreIssue { code: string; message: string }
type PackageReply<T> = { ok: true; value: T } | { ok: false; error: CoreIssue };
interface DefinitionSnapshot {
  modules: Record<string, Uint8Array<ArrayBuffer>>;
  commands: Record<string, { module: string }>;
  entrypoint: string | undefined;
  files: Record<string, Uint8Array<ArrayBuffer>>;
}
type OwnedPackageSource =
  | { kind: "definition"; definition: DefinitionSnapshot }
  | { kind: "bytes"; bytes: Uint8Array<ArrayBuffer>; dependencies: Readonly<Record<string, V2Package>> };

export function coreError(code: string, message: string): Error & { code: string } {
  const error = Object.assign(new Error(message), { code });
  error.name = "WasmerError";
  return error;
}

/** Package metadata and immutable atom bytes stay usable synchronously on JS. */
export class V2Package implements PackageCore {
  readonly #metadata: PackageMetadata;
  readonly #binaries: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  readonly #source: OwnedPackageSource;

  constructor(readonly runtime: BrowserRuntime, metadata: PackageMetadata,
    binaries: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, source: OwnedPackageSource) {
    this.#metadata = metadata;
    this.#binaries = binaries;
    this.#source = source;
  }
  get handle(): number { return this.#metadata.handle; }
  get id(): string { return this.#metadata.id; }
  get commands(): string[] { return [...this.#metadata.commands]; }
  get entrypoint(): string | undefined { return this.#metadata.entrypoint ?? undefined; }
  hasCommand(name: string): boolean { return this.#binaries.has(name); }
  importInto(packages: V2Packages): Promise<V2Package> { return packages.importSource(this.#source); }
  binary(name: string): Uint8Array<ArrayBuffer> {
    const bytes = this.#binaries.get(name);
    if (!bytes) throw coreError("COMMAND_NOT_FOUND", `package \`${this.id}\` does not export the command \`${name}\``);
    // Classic Command.binary() is synchronous and returns a fresh Uint8Array.
    return new Uint8Array(bytes);
  }
}

export class V2Packages implements Pick<WasmerCore, "createPackage"> {
  readonly #atoms = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #imports = new WeakMap<V2Package, Promise<V2Package>>();
  #closed = false;
  constructor(readonly runtime: BrowserRuntime) {
    runtime.onStop(() => { this.#closed = true; this.#atoms.clear(); });
  }

  async createPackage(definition: PackageDefinition): Promise<V2Package> {
    this.#ensureOpen();
    let snapshot: DefinitionSnapshot;
    try {
      const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
        if (!(bytes instanceof Uint8Array)) throw new TypeError("module and binary file contents must be Uint8Array values");
        return new Uint8Array(bytes);
      };
      snapshot = {
        modules: Object.fromEntries(Object.entries(definition.modules).map(([name, bytes]) => [name, copy(bytes)])),
        commands: Object.fromEntries(Object.entries(definition.commands).map(([name, command]) => [name, { ...command }])),
        entrypoint: definition.entrypoint,
        files: Object.fromEntries(Object.entries(definition.files ?? {}).map(([path, contents]) => [path,
          typeof contents === "string" ? new TextEncoder().encode(contents) : copy(contents)])),
      };
    } catch (cause) { throw coreError("INVALID_ARGUMENT", `invalid package definition: ${String(cause)}`); }
    return this.#createOwned(snapshot);
  }

  async #createOwned(snapshot: DefinitionSnapshot): Promise<V2Package> {
    const buffers: number[] = [];
    const upload = async (bytes: Uint8Array): Promise<number> => {
      const buffer = await this.runtime.upload(bytes);
      buffers.push(buffer);
      return buffer;
    };
    try {
      // Retain the existing definition shape and identity; no WEBC is synthesized.
      const modules: Record<string, number> = {}, files: Record<string, number> = {};
      for (const [name, bytes] of Object.entries(snapshot.modules)) modules[name] = await upload(bytes);
      for (const [path, bytes] of Object.entries(snapshot.files)) files[path] = await upload(bytes);
      const config = await upload(new TextEncoder().encode(JSON.stringify({ ...snapshot, modules, files })));
      return await this.#hydrate(await this.#call<PackageMetadata>("package_create", 0, { config }), { kind: "definition", definition: snapshot });
    } finally { await Promise.all(buffers.map(buffer => this.runtime.request("buffer_drop", buffer).catch(() => {}))); }
  }

  async loadBytes(bytes: Uint8Array, dependencies: Readonly<Record<string, V2Package>> = {}): Promise<V2Package> {
    this.#ensureOpen();
    const snapshot = new Uint8Array(bytes);
    return this.#loadOwned(snapshot, { ...dependencies });
  }

  async #loadOwned(snapshot: Uint8Array<ArrayBuffer>, dependencies: Readonly<Record<string, V2Package>>): Promise<V2Package> {
    const aliases: Record<string, number> = {};
    const imported: Record<string, V2Package> = {};
    for (const [alias, dependency] of Object.entries(dependencies)) {
      imported[alias] = await this.importPackage(dependency);
      aliases[alias] = imported[alias].handle;
    }
    const buffer = await this.runtime.upload(snapshot);
    let config: number | undefined;
    try {
      config = await this.runtime.upload(new TextEncoder().encode(JSON.stringify({ buffer, dependencies: aliases })));
      return await this.#hydrate(await this.#call<PackageMetadata>("package_load", 0, { config }), { kind: "bytes", bytes: snapshot, dependencies: imported });
    } finally {
      await this.runtime.request("buffer_drop", buffer).catch(() => {});
      if (config !== undefined) await this.runtime.request("buffer_drop", config).catch(() => {});
    }
  }

  requirePackage(pkg: PackageCore): V2Package {
    if (!(pkg instanceof V2Package)) throw coreError("INVALID_ARGUMENT", "expected an SDK package");
    return pkg;
  }

  importPackage(pkg: PackageCore): Promise<V2Package> {
    this.#ensureOpen();
    const requested = this.requirePackage(pkg);
    if (requested.runtime === this.runtime) return Promise.resolve(requested);
    let pending = this.#imports.get(requested);
    if (!pending) {
      pending = requested.importInto(this);
      this.#imports.set(requested, pending);
      void pending.catch(() => this.#imports.delete(requested));
    }
    return pending;
  }

  importSource(source: OwnedPackageSource): Promise<V2Package> {
    this.#ensureOpen();
    return source.kind === "definition" ? this.#createOwned(source.definition) : this.#loadOwned(source.bytes, source.dependencies);
  }

  async #hydrate(metadata: PackageMetadata, source: OwnedPackageSource): Promise<V2Package> {
    const binaries = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const command of metadata.commands) {
      const atom = await this.#call<{ buffer: number; hash: string }>("package_binary", metadata.handle, { command });
      let bytes = this.#atoms.get(atom.hash);
      try {
        if (!bytes) {
          bytes = await this.#download(atom.buffer);
          this.#atoms.set(atom.hash, bytes);
        }
      } finally { await this.runtime.request("buffer_drop", atom.buffer).catch(() => {}); }
      binaries.set(command, bytes);
    }
    return new V2Package(this.runtime, metadata, binaries, source);
  }

  async #call<T>(operation: string, handle: number, metadata: object): Promise<T> {
    let config: number | undefined;
    const encoded = new TextEncoder().encode(JSON.stringify(metadata));
    if (encoded.length > 65536) {
      config = await this.runtime.upload(encoded);
      metadata = { config };
    }
    let reply;
    try { reply = await this.runtime.request(operation, handle, metadata); }
    finally { if (config !== undefined) await this.runtime.request("buffer_drop", config).catch(() => {}); }
    const payload = (reply.value as { payload: number }).payload;
    let result: PackageReply<T>;
    try { result = JSON.parse(new TextDecoder().decode(await this.#download(payload))); }
    finally { await this.runtime.request("buffer_drop", payload).catch(() => {}); }
    if (!result.ok) throw coreError(result.error.code, result.error.message);
    return result.value;
  }

  async #download(handle: number): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const reply = await this.runtime.request("buffer_read", handle, { offset: length });
      if (reply.bytes.length === 0) break;
      chunks.push(reply.bytes);
      length += reply.bytes.length;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  #ensureOpen(): void { if (this.#closed) throw coreError("CLIENT_CLOSED", "the Wasmer client is closed"); }
}
