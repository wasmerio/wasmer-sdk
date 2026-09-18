// Reuses the SDK's host-network ABI. Swift owns DNS and TCP; this coordinator
// keeps synchronous socket operations off the UI thread with bounded buffers.
const CHUNK = 64 * 1024;
const RECEIVE_LIMIT = 1024 * 1024;
const SEND_LIMIT = 256 * 1024;
const METHODS = ["resolve", "connectTcp", "socketRead", "socketWrite", "socketFlush", "socketClose",
  "socketReadable", "socketWritable", "socketSetNoDelay", "socketSetKeepAlive", "socketRefresh"];
let nextID = 0;
const pending = new Map();
const bridges = new Map();
let nextBridgeID = 0;

export function receiveNativeNetworkReply(data) {
  if (data?.kind !== "networkResult") return false;
  const reply = pending.get(data.id);
  if (reply) {
    pending.delete(data.id);
    if (data.error) reply.reject(new Error(data.error)); else reply.resolve(data.value);
  }
  return true;
}
function callNative(method, args, owner) {
  return new Promise((resolve, reject) => {
    const id = ++nextID;
    pending.set(id, { resolve, reject, owner });
    postMessage({ kind: "network", id, method, args });
  });
}
function encode(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16 * 1024));
  }
  return btoa(text);
}

export class NativeNetworkBridge {
  id = ++nextBridgeID;
  #call;
  #sockets = new Map();
  #wake = () => true;
  #closed = false;
  constructor(call) { this.#call = call ?? ((method, args) => callNative(method, args, this.id)); }
  setWakeCallback(callback) { this.#wake = callback; }
  async resolve(host) { this.#checkOpen(); return await this.#call("resolve", [host]); }
  async connectTcp(local, peer) {
    this.#checkOpen();
    const descriptor = await this.#call("connectTcp", [local, peer]);
    if (this.#closed) {
      await this.#call("socketClose", [descriptor.id]);
      throw new Error("ENOTCONN: native bridge closed");
    }
    const state = { id: descriptor.id, chunks: [], offset: 0, buffered: 0, ended: false,
      closed: false, reading: false, sending: false, writes: [], queued: 0, error: undefined };
    this.#sockets.set(state.id, state);
    this.#read(state);
    return descriptor;
  }
  socketRead(id, maximum) {
    const state = this.#sockets.get(id);
    if (!state) return null;
    if (state.buffered === 0) {
      if (state.error) throw state.error;
      return state.ended ? null : undefined;
    }
    const bytes = new Uint8Array(Math.min(maximum, state.buffered, CHUNK));
    let count = 0;
    while (count < bytes.length) {
      const head = state.chunks[0];
      const length = Math.min(bytes.length - count, head.length - state.offset);
      bytes.set(head.subarray(state.offset, state.offset + length), count);
      count += length; state.offset += length; state.buffered -= length;
      if (state.offset === head.length) { state.chunks.shift(); state.offset = 0; }
    }
    this.#read(state);
    if (!state.buffered && (state.ended || state.error)) {
      queueMicrotask(() => this.#emit(id, state.error ? "error" : "close"));
    }
    return bytes;
  }
  socketWrite(id, bytes) {
    const state = this.#require(id);
    if (state.error) throw state.error;
    const length = Math.min(bytes.length, CHUNK, SEND_LIMIT - state.queued);
    if (!length && bytes.length) return -1;
    if (length) {
      state.writes.push(bytes.slice(0, length)); state.queued += length;
      this.#send(state);
    }
    return length;
  }
  socketFlush(id) {
    const state = this.#require(id);
    if (state.error) throw state.error;
    return state.queued === 0;
  }
  socketReadable(id) {
    const state = this.#sockets.get(id);
    if (!state) return 0;
    if (!state.buffered && state.error) throw state.error;
    return state.buffered || (state.ended ? 0 : -1);
  }
  socketWritable(id) {
    const state = this.#sockets.get(id);
    if (!state) return 0;
    if (state.error) throw state.error;
    return Math.min(CHUNK, SEND_LIMIT - state.queued) || -1;
  }
  socketClose(id) {
    const state = this.#sockets.get(id);
    if (!state) return;
    state.closed = true; state.chunks = []; state.writes = [];
    this.#sockets.delete(id);
    void this.#call("socketClose", [id]).catch(() => {});
  }
  socketSetNoDelay(id, enabled) { this.#option("socketSetNoDelay", id, enabled); }
  socketSetKeepAlive(id, enabled) { this.#option("socketSetKeepAlive", id, enabled); }
  socketRefresh(id) {
    queueMicrotask(() => {
      const state = this.#sockets.get(id);
      if (!state) return;
      if (state.buffered) this.#emit(id, "readable");
      if (state.ended && !state.buffered) this.#emit(id, "close");
      if (state.error && !state.buffered) this.#emit(id, "error");
      else if (state.queued < SEND_LIMIT) this.#emit(id, "writable");
    });
  }
  close() {
    for (const id of this.#sockets.keys()) this.socketClose(id);
    this.#closed = true; this.#wake = () => true;
    bridges.delete(this.id);
    for (const [id, reply] of pending) {
      if (reply.owner !== this.id) continue;
      pending.delete(id); reply.reject(new Error("ENOTCONN: native bridge closed"));
    }
  }
  #option(method, id, enabled) {
    const state = this.#require(id);
    void this.#call(method, [id, enabled]).catch((error) => this.#fail(state, error));
  }
  async #read(state) {
    if (state.closed || state.ended || state.error || state.reading || state.buffered > RECEIVE_LIMIT - CHUNK) return;
    state.reading = true;
    try {
      const value = await this.#call("socketRead", [state.id]);
      if (state.closed) return;
      if (value === null) {
        state.ended = true;
        // WASIX must drain already-received bytes before observing EOF.
        this.#emit(state.id, state.buffered ? "readable" : "close");
      }
      else {
        const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
        if (!bytes.length || bytes.length > CHUNK) throw new Error("EIO: invalid native TCP read");
        state.chunks.push(bytes); state.buffered += bytes.length;
        this.#emit(state.id, "readable");
      }
    } catch (error) { this.#fail(state, error); }
    finally { state.reading = false; }
    this.#read(state);
  }
  async #send(state) {
    if (state.sending) return;
    state.sending = true;
    try {
      while (!state.closed && state.writes.length) {
        const bytes = state.writes[0];
        const count = await this.#call("socketWrite", [state.id, encode(bytes)]);
        if (state.closed) break;
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length) throw new Error("EIO: invalid native TCP write");
        state.queued -= count;
        if (count === bytes.length) state.writes.shift(); else state.writes[0] = bytes.subarray(count);
        this.#emit(state.id, "writable");
      }
    } catch (error) { this.#fail(state, error); }
    finally { state.sending = false; }
  }
  #fail(state, error) {
    if (state.closed) return;
    state.error = error; this.#emit(state.id, state.buffered ? "readable" : "error");
  }
  #emit(id, event) {
    if (this.#closed || !this.#sockets.has(id)) return;
    if (!this.#wake(id, event)) setTimeout(() => this.#emit(id, event), 0);
  }
  #checkOpen() { if (this.#closed) throw new Error("ENOTCONN: native bridge closed"); }
  #require(id) {
    this.#checkOpen();
    const state = this.#sockets.get(id);
    if (!state) throw new Error("ENOTCONN: native socket closed");
    return state;
  }
}

export function installNativeNetworkGlobals(bridge) {
  bridges.set(bridge.id, bridge);
  for (const method of METHODS) {
    const name = "__wasmerHost" + method[0].toUpperCase() + method.slice(1);
    globalThis[name] = (bridgeID, ...args) => {
      const selected = bridges.get(bridgeID);
      if (!selected) throw new Error("ENOTCONN: unknown native network bridge");
      return selected[method](...args);
    };
  }
  globalThis.__wasmerHandleNetworkRpc = (request) => {
    if (request?.type !== "wasmer-network-rpc") return false;
    void respondToNetworkRequest(bridges.get(request.bridgeId), request);
    return true;
  };
}

export async function respondToNetworkRequest(bridge, request) {
  const control = new Int32Array(request.response, 0, 4);
  const payload = new Uint8Array(request.response, 16);
  try {
    if (request.bridgeId !== bridge?.id || !METHODS.includes(request.method)) throw new Error("Invalid native network operation");
    const result = await bridge[request.method](...request.args);
    if (result === undefined) control[1] = 3;
    else if (result === null) control[1] = 4;
    else {
      const bytes = result instanceof Uint8Array ? result : new TextEncoder().encode(JSON.stringify(result));
      if (bytes.length > payload.length) throw new Error("Native network response exceeds its worker mailbox");
      control[1] = result instanceof Uint8Array ? 2 : 1;
      control[2] = bytes.length; payload.set(bytes);
    }
  } catch (error) {
    const bytes = new TextEncoder().encode(String(error)).subarray(0, payload.length);
    control[1] = 5; control[2] = bytes.length; payload.set(bytes);
  }
  Atomics.store(control, 0, 1); Atomics.notify(control, 0);
}
