// Volatile file contents owned by the storage worker, outside the SDK's shared
// Wasm heap. Small pages bound write amplification and preserve sparse files.
const PAGE = 4096;
class MemoryFile {
  #pages = new Map(); #size = 0;
  getSize() { return this.#size; }
  read(output, {at}) {
    const count = Math.min(output.length, Math.max(0, this.#size - at));
    output.fill(0, 0, count);
    for (let done = 0; done < count;) {
      const position = at + done, offset = position % PAGE;
      const length = Math.min(PAGE - offset, count - done);
      const page = this.#pages.get(Math.floor(position / PAGE));
      if (page) output.set(page.subarray(offset, offset + length), done);
      done += length;
    }
    return count;
  }
  write(input, {at}) {
    for (let done = 0; done < input.length;) {
      const position = at + done, offset = position % PAGE, index = Math.floor(position / PAGE);
      const length = Math.min(PAGE - offset, input.length - done);
      let page = this.#pages.get(index);
      if (!page) { page = new Uint8Array(PAGE); this.#pages.set(index, page); }
      page.set(input.subarray(done, done + length), offset);
      done += length;
    }
    if (input.length) this.#size = Math.max(this.#size, at + input.length);
    return input.length;
  }
  truncate(size) {
    if (size < this.#size) {
      for (const index of this.#pages.keys()) if (index * PAGE >= size) this.#pages.delete(index);
      if (size % PAGE) this.#pages.get(Math.floor(size / PAGE))?.fill(0, size % PAGE);
    }
    this.#size = size;
  }
  flush() {}
  close() {}
}

export class MemoryDirectory {
  #files = new Map();
  async getFileHandle(name, {create} = {}) {
    let file = this.#files.get(name);
    if (!file && create) { file = new MemoryFile(); this.#files.set(name, file); }
    if (!file) throw Object.assign(new Error('File does not exist'), {code:'ENOENT'});
    return {async createSyncAccessHandle() { return file; }};
  }
  async removeEntry(name) { this.#files.delete(name); }
  clear() { this.#files.clear(); }
}
