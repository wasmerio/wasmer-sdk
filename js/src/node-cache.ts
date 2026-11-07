import {
  mkdir,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

let nextCacheId = 1;
const caches = new Map<number, NodePackageCache>();
let globalsInstalled = false;

/** Largest single read request; a read never needs a buffer of its own. */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

export type NodeCacheMethod =
  | "open"
  | "readInto"
  | "closeFile"
  | "put"
  | "remove";

/** An opened cache file, read with `readInto`. */
export interface OpenedCacheFile {
  handle: number;
  size: number;
}

/**
 * Project-local package storage shared with native Wasmer SDKs.
 *
 * Package images are tens of megabytes. Reads and writes go straight between
 * the file and the caller's buffer (usually a view of the SDK's shared
 * memory): a whole-file temporary would stay dirty in the allocator after it
 * is freed.
 */
export class NodePackageCache {
  readonly id = nextCacheId++;
  readonly #root: string;
  readonly #readOnly: boolean;
  readonly #files = new Map<number, FileHandle>();
  #nextFile = 1;

  constructor(directory: string, readOnly = false) {
    this.#root = resolve(directory);
    this.#readOnly = readOnly;
    caches.set(this.id, this);
  }

  /** Open a cached file, or return `undefined` if it does not exist. */
  async open(path: string): Promise<OpenedCacheFile | undefined> {
    let file: FileHandle;
    try {
      file = await open(this.#path(path), "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const { size } = await file.stat();
      const handle = this.#nextFile++;
      this.#files.set(handle, file);
      return { handle, size };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /**
   * Fill `destination` from the start of an opened file, then close it.
   * Returns the number of bytes read, which is short only if the file shrank.
   */
  async readInto(handle: number, destination: Uint8Array): Promise<number> {
    const file = this.#files.get(handle);
    if (!file) throw new Error(`unknown Wasmer cache file ${handle}`);
    this.#files.delete(handle);
    try {
      let total = 0;
      while (total < destination.byteLength) {
        const length = Math.min(
          READ_CHUNK_BYTES,
          destination.byteLength - total,
        );
        const { bytesRead } = await file.read(destination, total, length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return total;
    } finally {
      await file.close();
    }
  }

  /** Close a file that was opened but will not be read. */
  async closeFile(handle: number): Promise<void> {
    const file = this.#files.get(handle);
    this.#files.delete(handle);
    await file?.close();
  }

  /** Store `bytes`. They are written as given, without a copy. */
  async put(path: string, bytes: Uint8Array): Promise<void> {
    if (this.#readOnly) return;
    const destination = this.#path(path);
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true });
    const temporary = resolve(
      directory,
      `.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(path: string): Promise<void> {
    if (this.#readOnly) return;
    await rm(this.#path(path), { force: true });
  }

  close(): void {
    caches.delete(this.id);
    for (const file of this.#files.values()) file.close().catch(() => {});
    this.#files.clear();
  }

  #path(path: string): string {
    const destination = resolve(this.#root, path);
    const child = relative(this.#root, destination);
    if (child === "" || child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`invalid Wasmer cache path: ${path}`);
    }
    return destination;
  }
}

/**
 * Cache entry points for the SDK on this thread. The SDK keeps `bytes` and
 * `destination` alive until the returned promise settles, so neither is
 * copied.
 */
export function installNodeCacheGlobals(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerNodeCacheOpen = (cacheId: number, path: string) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "open", [path]);
  scope.__wasmerNodeCacheReadInto = (
    cacheId: number,
    handle: number,
    destination: Uint8Array,
  ) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "readInto", [
      handle,
      destination,
    ]);
  scope.__wasmerNodeCacheCloseFile = (cacheId: number, handle: number) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "closeFile", [handle]);
  scope.__wasmerNodeCachePut = (
    cacheId: number,
    path: string,
    bytes: Uint8Array,
  ) => dispatchNodeCacheCall(nodePackageCache(cacheId), "put", [path, bytes]);
  scope.__wasmerNodeCacheRemove = (cacheId: number, path: string) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "remove", [path]);
}

export function nodePackageCache(id: number): NodePackageCache {
  const cache = caches.get(id);
  if (!cache) throw new Error(`unknown Wasmer package cache ${id}`);
  return cache;
}

export async function dispatchNodeCacheCall(
  cache: NodePackageCache,
  method: NodeCacheMethod,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case "open":
      return cache.open(args[0] as string);
    case "readInto":
      return cache.readInto(args[0] as number, args[1] as Uint8Array);
    case "closeFile":
      return cache.closeFile(args[0] as number);
    case "put":
      return cache.put(args[0] as string, args[1] as Uint8Array);
    case "remove":
      return cache.remove(args[0] as string);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
