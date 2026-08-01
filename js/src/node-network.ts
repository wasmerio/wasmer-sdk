import dns from "node:dns/promises";
import net, { type Server, type Socket } from "node:net";

type Wake = (id: number, event: string) => void;
type Address = { address: string; port: number; family: string };
const bridges = new Map<number, NodeNetworkBridge>();
let nextBridgeId = 1;

/** Pause the socket once this much unread data is buffered. */
const RECEIVE_HIGH_WATER_BYTES = 1024 * 1024;
/** Resume the socket once the guest has drained the buffer to this level. */
const RECEIVE_RESUME_BYTES = 256 * 1024;

interface SocketState {
  socket: Socket;
  chunks: Uint8Array[];
  offset: number;
  buffered: number;
  ended: boolean;
}

interface ListenerState {
  server: Server;
  accepted: number[];
}

export type NodeNetworkMethod =
  | "resolve"
  | "connectTcp"
  | "listenTcp"
  | "listenerAccept"
  | "listenerReadable"
  | "listenerRefresh"
  | "listenerClose"
  | "socketRead"
  | "socketWrite"
  | "socketFlush"
  | "socketClose"
  | "socketReadable"
  | "socketWritable"
  | "socketSetNoDelay"
  | "socketSetKeepAlive"
  | "socketRefresh";

export class NodeNetworkBridge {
  readonly id: number;
  readonly #sockets = new Map<number, SocketState>();
  readonly #listeners = new Map<number, ListenerState>();
  #nextId = 1;
  #wake: Wake = () => {};

  constructor() {
    this.id = nextBridgeId++;
    bridges.set(this.id, this);
  }

  setWakeCallback(callback: Wake): void {
    this.#wake = callback;
  }

  close(): void {
    for (const listener of this.#listeners.values()) {
      listener.server.close();
    }
    this.#listeners.clear();
    for (const state of this.#sockets.values()) {
      state.socket.destroy();
    }
    this.#sockets.clear();
    this.#wake = () => {};
    bridges.delete(this.id);
  }

  async resolve(host: string): Promise<string[]> {
    return (await dns.lookup(host, { all: true })).map(({ address }) => address);
  }

  async connectTcp(localText: string, peerText: string): Promise<object> {
    const local = parseAddress(localText);
    const peer = parseAddress(peerText);
    const socket = net.createConnection({
      host: peer.host,
      port: peer.port,
      localAddress: isUnspecified(local.host) ? undefined : local.host,
      localPort: local.port || undefined,
      allowHalfOpen: true,
    });
    const id = this.#registerSocket(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    } catch (error) {
      // A refused connection (e.g. a readiness probe before the guest
      // listens) must not leave a dead entry in the socket table.
      this.#sockets.delete(id);
      socket.destroy();
      throw error;
    }
    return this.#descriptor(id);
  }

  listenTcp(addressText: string): object {
    const address = parseAddress(addressText);
    const id = this.#nextId++;
    const accepted: number[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      accepted.push(this.#registerSocket(socket));
      this.#wake(id, "connection");
    });
    this.#listeners.set(id, { server, accepted });
    server.once("listening", () => this.#wake(id, "writable"));
    server.once("error", () => this.#wake(id, "error"));
    server.listen({ host: address.host, port: address.port });
    return { id, local: addressText };
  }

  listenerAccept(id: number): object | undefined {
    const listener = this.#listeners.get(id);
    const socketId = listener?.accepted.shift();
    return socketId === undefined ? undefined : this.#descriptor(socketId);
  }

  listenerRefresh(id: number): void {
    queueMicrotask(() => {
      if ((this.#listeners.get(id)?.accepted.length ?? 0) > 0) {
        this.#wake(id, "connection");
      }
    });
  }

  listenerReadable(id: number): boolean {
    return (this.#listeners.get(id)?.accepted.length ?? 0) > 0;
  }

  listenerClose(id: number): void {
    const listener = this.#listeners.get(id);
    listener?.server.close();
    for (const socketId of listener?.accepted ?? []) {
      this.socketClose(socketId);
    }
    this.#listeners.delete(id);
  }

  socketRead(id: number, maximum: number): Uint8Array | null | undefined {
    const state = this.#sockets.get(id);
    if (!state) return null;
    if (state.buffered === 0) return state.ended ? null : undefined;

    const output = new Uint8Array(Math.min(maximum, state.buffered));
    let written = 0;
    while (written < output.length) {
      const chunk = state.chunks[0]!;
      const count = Math.min(output.length - written, chunk.length - state.offset);
      output.set(chunk.subarray(state.offset, state.offset + count), written);
      written += count;
      state.offset += count;
      state.buffered -= count;
      if (state.offset === chunk.length) {
        state.chunks.shift();
        state.offset = 0;
      }
    }
    if (state.socket.isPaused() && state.buffered <= RECEIVE_RESUME_BYTES) {
      state.socket.resume();
    }
    return output;
  }

  socketWrite(id: number, bytes: Uint8Array): number {
    const state = this.#sockets.get(id);
    if (!state || state.socket.destroyed) throw new Error("socket is closed");
    state.socket.write(Buffer.from(bytes));
    return bytes.byteLength;
  }

  socketFlush(id: number): boolean {
    return !(this.#sockets.get(id)?.socket.writableNeedDrain ?? false);
  }

  socketClose(id: number): void {
    this.#sockets.get(id)?.socket.destroy();
    this.#sockets.delete(id);
  }

  socketReadable(id: number): number {
    const state = this.#sockets.get(id);
    if (!state) return 0;
    return state.buffered || (state.ended ? 0 : -1);
  }

  socketWritable(id: number): number {
    const socket = this.#sockets.get(id)?.socket;
    if (!socket || socket.destroyed) return 0;
    return socket.writableNeedDrain ? -1 : 64 * 1024;
  }

  socketSetNoDelay(id: number, enabled: boolean): void {
    this.#sockets.get(id)?.socket.setNoDelay(enabled);
  }

  socketSetKeepAlive(id: number, enabled: boolean): void {
    this.#sockets.get(id)?.socket.setKeepAlive(enabled);
  }

  socketRefresh(id: number): void {
    queueMicrotask(() => {
      const state = this.#sockets.get(id);
      if (!state) return;
      if (state.buffered > 0) this.#wake(id, "readable");
      if (state.ended) this.#wake(id, "close");
      if (!state.socket.destroyed && !state.socket.writableNeedDrain) {
        this.#wake(id, "writable");
      }
    });
  }

  #registerSocket(socket: Socket): number {
    const id = this.#nextId++;
    const state: SocketState = {
      socket,
      chunks: [],
      offset: 0,
      buffered: 0,
      ended: false,
    };
    this.#sockets.set(id, state);
    socket.on("data", (chunk: Buffer) => {
      const copy = new Uint8Array(chunk);
      state.chunks.push(copy);
      state.buffered += copy.byteLength;
      // Backpressure: a peer that sends faster than the guest reads must not
      // grow host memory without bound. `socketRead` resumes the socket once
      // the buffer drains.
      if (state.buffered >= RECEIVE_HIGH_WATER_BYTES && !socket.isPaused()) {
        socket.pause();
      }
      this.#wake(id, "readable");
    });
    socket.on("drain", () => this.#wake(id, "writable"));
    socket.on("end", () => {
      state.ended = true;
      this.#wake(id, "close");
    });
    socket.on("close", () => {
      state.ended = true;
      this.#wake(id, "close");
    });
    socket.on("error", () => this.#wake(id, "error"));
    return id;
  }

  #descriptor(id: number): object {
    const socket = this.#sockets.get(id)?.socket;
    if (!socket) throw new Error(`unknown socket ${id}`);
    return {
      id,
      local: formatAddress(socket.address() as Address | string | null),
      peer: formatAddress({
        address: socket.remoteAddress ?? "0.0.0.0",
        port: socket.remotePort ?? 0,
        family: socket.remoteFamily ?? "IPv4",
      }),
    };
  }
}

export function installNodeNetworkGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerHostResolve = (bridgeId: number, host: string) =>
    bridgeFor(bridgeId).resolve(host);
  scope.__wasmerHostConnectTcp = (
    bridgeId: number,
    local: string,
    peer: string,
  ) => bridgeFor(bridgeId).connectTcp(local, peer);
  scope.__wasmerHostListenTcp = (bridgeId: number, address: string) =>
    bridgeFor(bridgeId).listenTcp(address);
  scope.__wasmerHostListenerAccept = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).listenerAccept(id);
  scope.__wasmerHostListenerRefresh = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).listenerRefresh(id);
  scope.__wasmerHostListenerReadable = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).listenerReadable(id);
  scope.__wasmerHostListenerClose = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).listenerClose(id);
  scope.__wasmerHostSocketRead = (
    bridgeId: number,
    id: number,
    maximum: number,
  ) => bridgeFor(bridgeId).socketRead(id, maximum);
  scope.__wasmerHostSocketWrite = (
    bridgeId: number,
    id: number,
    bytes: Uint8Array,
  ) => bridgeFor(bridgeId).socketWrite(id, bytes);
  scope.__wasmerHostSocketFlush = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).socketFlush(id);
  scope.__wasmerHostSocketClose = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).socketClose(id);
  scope.__wasmerHostSocketReadable = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).socketReadable(id);
  scope.__wasmerHostSocketWritable = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).socketWritable(id);
  scope.__wasmerHostSocketSetNoDelay = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => bridgeFor(bridgeId).socketSetNoDelay(id, enabled);
  scope.__wasmerHostSocketSetKeepAlive = (
    bridgeId: number,
    id: number,
    enabled: boolean,
  ) => bridgeFor(bridgeId).socketSetKeepAlive(id, enabled);
  scope.__wasmerHostSocketRefresh = (bridgeId: number, id: number) =>
    bridgeFor(bridgeId).socketRefresh(id);
}

export function nodeNetworkBridge(bridgeId: number): NodeNetworkBridge {
  return bridgeFor(bridgeId);
}

export async function dispatchNodeNetworkCall(
  bridge: NodeNetworkBridge,
  method: NodeNetworkMethod,
  args: unknown[],
): Promise<unknown> {
  const callable = bridge[method] as (...values: unknown[]) => unknown;
  return await callable.apply(bridge, args);
}

function parseAddress(value: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]) };
  const separator = value.lastIndexOf(":");
  return {
    host: value.slice(0, separator),
    port: Number(value.slice(separator + 1)),
  };
}

function formatAddress(value: Address | string | null): string {
  if (!value || typeof value === "string") return "0.0.0.0:0";
  return value.address.includes(":")
    ? `[${value.address}]:${value.port}`
    : `${value.address}:${value.port}`;
}

function isUnspecified(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function bridgeFor(id: number): NodeNetworkBridge {
  const bridge = bridges.get(id);
  if (!bridge) throw new Error(`unknown or closed Node network bridge ${id}`);
  return bridge;
}
