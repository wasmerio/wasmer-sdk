import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
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

export type NodeCacheMethod = "get" | "put" | "remove";

/** Project-local package storage shared with native Wasmer SDKs. */
export class NodePackageCache {
  readonly id = nextCacheId++;
  readonly #root: string;
  readonly #readOnly: boolean;

  constructor(directory: string, readOnly = false) {
    this.#root = resolve(directory);
    this.#readOnly = readOnly;
    caches.set(this.id, this);
  }

  async get(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.#path(path));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

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

export function installNodeCacheGlobals(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerNodeCacheGet = (cacheId: number, path: string) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "get", [path]);
  scope.__wasmerNodeCachePut = (
    cacheId: number,
    path: string,
    bytes: Uint8Array,
  ) =>
    dispatchNodeCacheCall(nodePackageCache(cacheId), "put", [
      path,
      bytes.slice(),
    ]);
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
    case "get":
      return cache.get(args[0] as string);
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
