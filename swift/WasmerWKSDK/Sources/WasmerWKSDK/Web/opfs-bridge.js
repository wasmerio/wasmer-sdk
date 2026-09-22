import { respondToHostFileSystem } from './sdk/dist/host-filesystem.js';
// Keep the storage worker separate: the SDK coordinator can block in a
// synchronous filesystem call while this worker completes its OPFS promises.
export class OPFSStorage {
  #worker; #next = 0x80000000; #requests = new Map(); #mounts = new Set(); #error;
  #start() {
    if (this.#worker) return;
    const worker = new Worker(new URL('./opfs-worker.js', import.meta.url), {type:'module'});
    this.#worker = worker;
    worker.onmessage = ({data}) => {
      const request = this.#requests.get(data.id); if (!request) return;
      this.#requests.delete(data.id);
      if (data.error) request.reject(Object.assign(new Error(data.error.message), {code:data.error.code}));
      else request.resolve(data.value);
    };
    worker.onerror = event => {
      this.#error = {code:'EIO', message:event.message || 'OPFS worker failed'};
      for (const request of this.#requests.values()) request.reject(Object.assign(new Error(this.#error.message), this.#error));
      this.#requests.clear();
    };
  }
  #call(method, args) {
    this.#start();
    if (this.#error) return Promise.reject(Object.assign(new Error(this.#error.message), this.#error));
    return new Promise((resolve,reject) => {
      const id = crypto.randomUUID(); this.#requests.set(id,{resolve,reject});
      this.#worker.postMessage({id,method,...args});
    });
  }
  async open(volume) {
    const mount = ++this.#next;
    await this.#call('open', {mount,volume}); this.#mounts.add(mount); return mount;
  }
  async close(mount) {
    try { await this.#call('close',{mount}); } finally { this.#mounts.delete(mount); }
  }
  async closeAll() {
    await Promise.all([...this.#mounts].map(mount => this.close(mount)));
  }
  route(request) {
    if (request.mount < 0x80000000) return false;
    if (this.#error || !this.#mounts.has(request.mount)) {
      respondToHostFileSystem(request, {error:this.#error ?? {code:'EBADF',message:'OPFS volume is closed'}});
    } else this.#worker.postMessage(request);
    return true;
  }
}
