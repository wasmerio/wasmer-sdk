// A worker-owned OPFS volume. A small append-only namespace journal makes
// directory rename atomic in the virtual namespace and keeps metadata lookups
// local. File contents live in separate OPFS files and never fill the SDK heap.
import { MemoryDirectory } from './memory-filesystem.js';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const MAX_BYTES = 65536;
const encoder = new TextEncoder();
function path(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\0")) fail("EINVAL", "Invalid relative path");
  const parts = value.split("/").filter(part => part && part !== ".");
  if (parts.includes("..")) fail("EACCES", "Path escapes volume");
  return parts.join("/");
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("EINVAL", "Invalid file offset or size");
  return value;
}
function writeAll(handle, bytes, at) {
  let done = 0;
  while (done < bytes.length) {
    const count = handle.write(bytes.subarray(done), { at: at + done });
    if (!count) fail("EIO", "Short OPFS write");
    done += count;
  }
}
export function filesystemError(error) {
  return { code: (typeof error.code === "string" ? error.code : undefined) ?? ({ NotFoundError: "ENOENT", QuotaExceededError: "ENOSPC", NoModificationAllowedError: "EBUSY",
    NotAllowedError: "EACCES", TypeMismatchError: "ENOTDIR", InvalidStateError: "EIO" }[error.name] ?? "EIO"),
    message: error.message ?? String(error) };
}
export class OPFSVolume {
  #directory; #journal; #nodes = new Map([["", {kind:"directory", size:0}]]);
  #inodes = new Map(); #children = new Map([["", new Set()]]); #unlinked = new Set();
  #handles = new Map(); #files = new Map(); #nextFile = 0; #nextDescriptor = 0; #position = 0;
  #closed = false; #release; #dirty = false; #timer; #syncError; #garbage;
  static memory() {
    const directory = new MemoryDirectory();
    return new OPFSVolume(directory, null, async () => directory.clear());
  }
  static async open(name, storage = navigator.storage, locks = navigator.locks) {
    if (!/^[\p{L}\p{N}_ -]{1,128}$/u.test(name)) fail("EINVAL", "Invalid OPFS volume name");
    if (!storage?.getDirectory || !locks?.request) fail("ENOTSUP", "OPFS and Web Locks are required");
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    let acquired, rejected;
    const ready = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
    const lease = locks.request(`wasmer-opfs:${name}`, { ifAvailable: true }, async lock => {
      if (!lock) fail("EBUSY", "OPFS volume is already open in another runtime");
      acquired(); await held;
    });
    lease.catch(rejected);
    await ready;
    try {
      const root = await storage.getDirectory();
      const volumes = await root.getDirectoryHandle("wasmer-volumes", {create:true});
      const directory = await volumes.getDirectoryHandle(name, {create:true});
      const handle = await directory.getFileHandle("namespace.log", {create:true});
      const journal = await handle.createSyncAccessHandle();
      const volume = new OPFSVolume(directory, journal, async () => { unlock(); await lease; });
      try {
        volume.#replay();
        // Reclaim files unlinked before a crash, and failed creations that never
        // reached the namespace journal. No guest can access the volume yet.
        const live = new Set([...volume.#nodes.values()].filter(node => node.id).map(node => `data-${node.id}`));
        volume.#inodes = new Map([...volume.#nodes.values()].filter(node => node.id).map(node => [node.id, node]));
        const garbage = [];
        for await (const name of directory.keys()) {
          const id = /^data-(\d+)$/.exec(name)?.[1];
          if (id) {
            // A failed creation may not have reached the journal. Reserve its
            // ID before serving requests so cleanup cannot delete a new file.
            volume.#nextFile = Math.max(volume.#nextFile, Number(id));
            if (!live.has(name)) garbage.push(name);
          }
        }
        // Deleting thousands of files must not delay opening the shell.
        volume.#garbage = (async () => {
          for (const name of garbage) {
            if (volume.#closed) break;
            await directory.removeEntry(name);
          }
        })().catch(error => console.warn("OPFS cleanup deferred until next open:", error.message));
      } catch (error) { journal.close(); throw error; }
      volume.#timer = setInterval(() => {
        try { volume.#sync(); } catch (error) { volume.#syncError = error; }
      }, 1000);
      return volume;
    } catch (error) { unlock(); await lease; throw error; }
  }
  constructor(directory, journal, release) {
    this.#directory = directory; this.#journal = journal; this.#release = release;
    // An explicit fsync flushes immediately; periodic checkpoints also preserve
    // ordinary shell writes without depending on app shutdown.
  }
  #set(name, node) {
    this.#nodes.set(name, node);
    if (node.id) this.#inodes.set(node.id, node);
    const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    this.#children.get(parent)?.add(name);
    if (node.kind === "directory" && !this.#children.has(name)) this.#children.set(name, new Set());
  }
  #delete(name) {
    this.#nodes.delete(name); this.#children.delete(name);
    const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    this.#children.get(parent)?.delete(name);
  }
  #replay() {
    let remainder = "", position = 0, valid = 0;
    const length = this.#journal.getSize(), bytes = new Uint8Array(MAX_BYTES);
    const decode = new TextDecoder();
    while (position < length) {
      const count = this.#journal.read(bytes, {at:position});
      if (!count) fail("EIO", "Truncated OPFS journal");
      position += count;
      remainder += decode.decode(bytes.subarray(0, count), {stream:true});
      let newline;
      while ((newline = remainder.indexOf("\n")) >= 0) {
        const line = remainder.slice(0, newline);
        this.#apply(JSON.parse(line));
        valid += encoder.encode(line + "\n").length;
        remainder = remainder.slice(newline + 1);
      }
    }
    // A killed writer may leave an incomplete final record. Earlier records
    // remain intact; never append behind an incomplete record.
    this.#journal.truncate(valid); this.#position = valid;
  }
  #apply([operation, a, b]) {
    if (operation === "put") {
      this.#set(a, b);
      if (b.id) this.#nextFile = Math.max(this.#nextFile, b.id);
    } else if (operation === "remove") this.#delete(a);
    else if (operation === "rename") {
      const moved = [...this.#nodes].filter(([name]) => name === a || name.startsWith(a + "/"));
      for (const [name] of moved) this.#delete(name);
      for (const [name, node] of moved) this.#set(b + name.slice(a.length), node);
    } else if (operation === "size") {
      const node = this.#inodes.get(a); if (node) node.size = b;
    } else fail("EIO", "Invalid OPFS journal record");
  }
  #commit(record) {
    if (!this.#journal) { this.#apply(record); return; }
    const bytes = encoder.encode(JSON.stringify(record) + "\n");
    try { writeAll(this.#journal, bytes, this.#position); }
    catch (error) { this.#journal.truncate(this.#position); throw error; }
    this.#position += bytes.length; this.#apply(record); this.#dirty = true;
  }
  #lookup(name) { const value = this.#nodes.get(name); if (!value) fail("ENOENT", name); return value; }
  #parent(name) {
    if (!name) fail("EACCES", "Cannot change volume root");
    const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    if (this.#lookup(parent).kind !== "directory") fail("ENOTDIR", parent);
  }
  #file(id) { const file = this.#files.get(integer(id)); if (!file) fail("EBADF", "File is closed"); return file; }
  async #releaseUnlinked(node) {
    // Persistent volumes reclaim orphaned files on reopening. Volatile volumes
    // must release bytes now, while preserving POSIX open-after-unlink behavior.
    if (this.#journal || !this.#unlinked.has(node) ||
        [...this.#files.values()].some(file => file.node === node)) return;
    this.#handles.delete(node.id); this.#inodes.delete(node.id);
    await this.#directory.removeEntry(`data-${node.id}`);
    this.#unlinked.delete(node);
  }
  async #unlink(node) {
    if (!this.#journal && node?.id) this.#unlinked.add(node);
    await this.#releaseUnlinked(node);
  }
  async #handle(node, create = false) {
    let handle = this.#handles.get(node.id);
    if (!handle) {
      const file = await this.#directory.getFileHandle(`data-${node.id}`, {create});
      handle = await file.createSyncAccessHandle(); this.#handles.set(node.id, handle);
      if (create) handle.truncate(0);
    }
    // Touch this entry so eviction keeps the most recently used files.
    this.#handles.delete(node.id); this.#handles.set(node.id, handle);
    return handle;
  }
  #trimHandles() {
    const active = new Set([...this.#files.values()].map(file => file.node.id));
    for (const [id, handle] of this.#handles) {
      if (this.#handles.size <= 64) break;
      if (!active.has(id)) { handle.flush(); handle.close(); this.#handles.delete(id); }
    }
  }
  #sync() {
    if (this.#closed || !this.#dirty) return;
    for (const handle of this.#handles.values()) handle.flush();
    this.#journal?.flush(); this.#dirty = false;
  }
  async request(method, args) {
    if (this.#closed) fail("EBADF", "Volume is closed");
    if (this.#syncError) throw this.#syncError;
    switch (method) {
      case "stat": { const node = this.#lookup(path(args[0])); return {kind:node.kind, size:node.size}; }
      case "readDir": {
        const name = path(args[0]);
        if (this.#lookup(name).kind !== "directory") fail("ENOTDIR", name);
        const prefix = name ? name + "/" : "";
        return [...this.#children.get(name)].map(key => {
          const node = this.#nodes.get(key); return {name:key.slice(prefix.length), kind:node.kind, size:node.size};
        });
      }
      case "mkdir": {
        const name = path(args[0]); this.#parent(name);
        if (this.#nodes.has(name)) fail("EEXIST", name);
        this.#commit(["put", name, {kind:"directory", size:0}]); return null;
      }
      case "open": {
        const [raw, read, write, create, exclusive, truncate, append] = args, name = path(raw);
        this.#parent(name); let node = this.#nodes.get(name);
        if (node && exclusive) fail("EEXIST", name);
        if (!node) {
          if (!create && !exclusive) fail("ENOENT", name);
          node = {kind:"file", id:++this.#nextFile, size:0};
          await this.#handle(node, true);
          try { this.#commit(["put", name, node]); }
          catch (error) {
            this.#handles.get(node.id)?.close(); this.#handles.delete(node.id);
            await this.#directory.removeEntry(`data-${node.id}`); throw error;
          }
        }
        if (node.kind !== "file") fail("EISDIR", name);
        const handle = await this.#handle(node);
        if (truncate) { if (!write && !append) fail("EACCES", name); handle.truncate(0); this.#commit(["size", node.id, 0]); }
        const id = ++this.#nextDescriptor;
        this.#files.set(id, {node, handle, read, write:write || append, append}); this.#trimHandles(); return id;
      }
      case "read": {
        const file = this.#file(args[0]), offset = integer(args[1]), count = integer(args[2]);
        if (!file.read) fail("EACCES", "File is not readable");
        if (count > MAX_BYTES) fail("EINVAL", "Read exceeds bridge limit");
        const bytes = new Uint8Array(count), length = file.handle.read(bytes, {at:offset});
        return bytes.subarray(0, length);
      }
      case "write": {
        const file = this.#file(args[0]); let offset = integer(args[1]);
        if (!file.write) fail("EACCES", "File is not writable");
        if (!(Array.isArray(args[2]) || args[2] instanceof Uint8Array) || args[2].length > MAX_BYTES ||
            args[2].some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) fail("EINVAL", "Invalid write bytes");
        const bytes = Uint8Array.from(args[2]);
        if (file.append) offset = file.handle.getSize();
        const count = file.handle.write(bytes, {at:offset});
        const size = file.handle.getSize();
        if (size !== file.node.size) this.#commit(["size", file.node.id, size]);
        this.#dirty = true; return count;
      }
      case "setLen": {
        const file = this.#file(args[0]); if (!file.write) fail("EACCES", "File is not writable");
        const size = integer(args[1]); file.handle.truncate(size); this.#commit(["size", file.node.id, size]); return null;
      }
      case "close": {
        const id = integer(args[0]), node = this.#files.get(id)?.node;
        this.#files.delete(id); this.#trimHandles(); await this.#releaseUnlinked(node); return null;
      }
      case "flush": this.#file(args[0]).handle.flush(); this.#journal?.flush(); return null;
      case "sync": this.#sync(); return null;
      case "remove": {
        const name = path(args[0]); this.#parent(name); const node = this.#lookup(name);
        if (this.#children.get(name)?.size) fail("ENOTEMPTY", name);
        this.#commit(["remove", name]); await this.#unlink(node); return null;
      }
      case "rename": {
        const from = path(args[0]), to = path(args[1]); this.#parent(from); this.#parent(to);
        const source = this.#lookup(from); if (from === to) return null;
        if (to.startsWith(from + "/")) fail("EINVAL", "Cannot move directory into itself");
        const target = this.#nodes.get(to);
        if (target) {
          if (target.kind !== source.kind) fail(target.kind === "directory" ? "EISDIR" : "ENOTDIR", to);
          if (this.#children.get(to)?.size) fail("ENOTEMPTY", to);
        }
        this.#commit(["rename", from, to]); await this.#unlink(target); return null;
      }
      default: fail("ENOTSUP", `Unsupported filesystem operation: ${method}`);
    }
  }
  async close() {
    if (this.#closed) return;
    clearInterval(this.#timer);
    let failure = this.#syncError;
    try { this.#sync(); } catch (error) { failure ??= error; }
    this.#closed = true;
    await this.#garbage;
    for (const handle of this.#handles.values()) {
      try { handle.close(); } catch (error) { failure ??= error; }
    }
    this.#handles.clear(); this.#files.clear();
    try { this.#journal?.close(); } catch (error) { failure ??= error; }
    if (!this.#journal) this.#directory.clear();
    this.#nodes.clear(); this.#inodes.clear(); this.#children.clear(); this.#unlinked.clear();
    await this.#release();
    if (failure) throw failure;
  }
}
