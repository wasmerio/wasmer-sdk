import { client as wisp } from "@mercuryworkshop/wisp-js/client";

import { NETWORK_RPC_CONTROL_BYTES } from "./node-network-rpc.js";
import type { NodeNetworkMethod } from "./node-network.js";

type Wake = (id: number, event: string) => boolean;
type WispStream = ReturnType<wisp.ClientConnection["create_stream"]>;
type WispUrlProvider = (request: {
  url?: string;
  error?: Error;
}) => string | Promise<string>;

interface SocketState {
  stream: WispStream;
  chunks: Uint8Array[];
  offset: number;
  buffered: number;
  ended: boolean;
}

interface DnsCacheEntry {
  addresses: string[];
  expiresAt: number;
}

interface NetworkRequest {
  type: "wasmer-network-rpc";
  bridgeId: number;
  method: NodeNetworkMethod;
  args: unknown[];
  response: SharedArrayBuffer;
}

const bridges = new Map<number, WispNetworkBridge>();
let nextBridgeId = 1;

const RECEIVE_LIMIT_BYTES = 16 * 1024 * 1024;

/** TCP and DNS egress for a browser WASIX sandbox, multiplexed over WISP. */
export class WispNetworkBridge {
  readonly id = nextBridgeId++;
  readonly #sockets = new Map<number, SocketState>();
  readonly #dnsCache = new Map<string, DnsCacheEntry>();
  // WASIX connects by resolved address. Retain its originating hostname so
  // WISP performs the remote connection without pinning traffic to one CDN IP.
  readonly #resolvedHosts = new Map<string, string>();
  readonly #dnsUrl: URL;
  readonly #requestUrl?: WispUrlProvider;
  #url?: string;
  #connection?: wisp.ClientConnection;
  #openingConnection?: wisp.ClientConnection;
  #connectionPromise?: Promise<wisp.ClientConnection>;
  #endpointRevision = 0;
  #nextSocketId = 1;
  #wake: Wake = () => true;
  #closed = false;

  constructor(
    url?: string,
    dnsUrl = "https://cloudflare-dns.com/dns-query",
    requestUrl?: WispUrlProvider,
  ) {
    this.#url = url?.trim() || undefined;
    this.#requestUrl = requestUrl;
    this.#dnsUrl = new URL(dnsUrl, globalThis.location?.href);
    if (this.#dnsUrl.protocol !== "https:" && this.#dnsUrl.protocol !== "http:") {
      throw new TypeError("WISP DNS endpoint must use http: or https:");
    }
    bridges.set(this.id, this);
  }

  setWakeCallback(callback: Wake): void {
    this.#wake = callback;
  }

  setUrl(url: string): void {
    if (this.#closed) throw new Error("WISP network bridge is closed");
    this.#url = validateWispUrl(url).href;
    this.#endpointRevision += 1;
    const opening = this.#openingConnection;
    const connected = this.#connection;
    this.#openingConnection = undefined;
    this.#connection = undefined;
    this.#closeSockets();
    opening?.close();
    if (connected !== opening) connected?.close();
  }

  async resolve(host: string): Promise<string[]> {
    if (isIpAddress(host)) return [stripIpv6Brackets(host)];
    const normalized = host.toLowerCase();
    if (normalized === "localhost") return ["127.0.0.1"];
    const cached = this.#dnsCache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      this.#rememberResolvedHost(normalized, cached.addresses);
      return [...cached.addresses];
    }
    // DNS is the first outbound operation for most socket clients. Establish
    // the configured transport here so applications can request or replace a
    // WISP endpoint before a failed lookup terminates the guest operation.
    await this.#getConnection();
    const answer = await resolveIpAddresses(this.#dnsUrl, normalized);
    this.#dnsCache.set(normalized, {
      addresses: answer.addresses,
      expiresAt: Date.now() + answer.ttlSeconds * 1_000,
    });
    this.#rememberResolvedHost(normalized, answer.addresses);
    return [...answer.addresses];
  }

  async connectTcp(_localText: string, peerText: string): Promise<object> {
    if (this.#closed) throw new Error("WISP network bridge is closed");
    const connection = await this.#getConnection();
    const peer = parseAddress(peerText);
    const destination =
      this.#resolvedHosts.get(stripIpv6Brackets(peer.host)) ?? peer.host;
    const stream = connection.create_stream(destination, peer.port, "tcp");
    const id = this.#nextSocketId++;
    const state: SocketState = {
      stream,
      chunks: [],
      offset: 0,
      buffered: 0,
      ended: false,
    };
    this.#sockets.set(id, state);
    stream.onmessage = (data) => {
      if (state.ended) return;
      const copy = Uint8Array.from(data);
      if (state.buffered + copy.byteLength > RECEIVE_LIMIT_BYTES) {
        state.ended = true;
        stream.close(0x03);
        this.#emitWake(id, "error");
        return;
      }
      state.chunks.push(copy);
      state.buffered += copy.byteLength;
      this.#emitWake(id, "readable");
    };
    stream.onclose = () => {
      state.ended = true;
      this.#emitWake(id, "close");
    };
    queueMicrotask(() => this.#emitWake(id, "writable"));
    return {
      id,
      local: "0.0.0.0:0",
      peer: formatAddress(peer.host, peer.port),
    };
  }

  socketRead(id: number, maximum: number): Uint8Array | null | undefined {
    const state = this.#sockets.get(id);
    if (!state) return null;
    if (state.buffered === 0) return state.ended ? null : undefined;

    const output = new Uint8Array(Math.min(maximum, state.buffered));
    let written = 0;
    while (written < output.byteLength) {
      const chunk = state.chunks[0]!;
      const count = Math.min(output.byteLength - written, chunk.byteLength - state.offset);
      output.set(chunk.subarray(state.offset, state.offset + count), written);
      written += count;
      state.offset += count;
      state.buffered -= count;
      if (state.offset === chunk.byteLength) {
        state.chunks.shift();
        state.offset = 0;
      }
    }
    return output;
  }

  socketWrite(id: number, bytes: Uint8Array): number {
    const state = this.#requireSocket(id);
    if (state.ended) throw new Error("WISP stream is closed");
    state.stream.send(Uint8Array.from(bytes));
    return bytes.byteLength;
  }

  socketFlush(id: number): boolean {
    return !this.#requireSocket(id).ended;
  }

  socketClose(id: number): void {
    const state = this.#sockets.get(id);
    if (!state) return;
    state.ended = true;
    state.stream.close();
    this.#sockets.delete(id);
  }

  socketReadable(id: number): number {
    const state = this.#sockets.get(id);
    if (!state) return 0;
    return state.buffered || (state.ended ? 0 : -1);
  }

  socketWritable(id: number): number {
    const state = this.#sockets.get(id);
    return state && !state.ended ? 64 * 1024 : 0;
  }

  socketSetNoDelay(id: number, _enabled: boolean): void {
    this.#requireSocket(id);
  }

  socketSetKeepAlive(id: number, _enabled: boolean): void {
    this.#requireSocket(id);
  }

  socketRefresh(id: number): void {
    queueMicrotask(() => {
      const state = this.#sockets.get(id);
      if (!state) return;
      if (state.buffered > 0) this.#emitWake(id, "readable");
      if (state.ended) this.#emitWake(id, "close");
      else this.#emitWake(id, "writable");
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    bridges.delete(this.id);
    this.#closeSockets();
    this.#openingConnection?.close();
    this.#connection?.close();
    this.#openingConnection = undefined;
    this.#connection = undefined;
    this.#wake = () => true;
  }

  async #getConnection(): Promise<wisp.ClientConnection> {
    if (this.#closed) throw new Error("WISP network bridge is closed");
    if (this.#connection) return this.#connection;
    if (this.#connectionPromise) return this.#connectionPromise;

    const pending = this.#connect();
    this.#connectionPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.#connectionPromise === pending) this.#connectionPromise = undefined;
    }
  }

  async #connect(): Promise<wisp.ClientConnection> {
    let url = this.#url;
    let previousUrl: string | undefined;
    let failure: Error | undefined;

    for (;;) {
      if (!url) {
        if (!this.#requestUrl) {
          throw failure ?? new Error("No WISP endpoint is configured");
        }
        const requestRevision = this.#endpointRevision;
        const requestedUrl = await this.#requestUrl({
          url: previousUrl,
          error: failure,
        });
        if (requestRevision !== this.#endpointRevision) {
          url = this.#url;
          previousUrl = undefined;
          failure = undefined;
          continue;
        }
        url = requestedUrl;
      }

      const endpointRevision = this.#endpointRevision;
      try {
        const endpoint = validateWispUrl(url);
        return await this.#openConnection(endpoint);
      } catch (error) {
        if (this.#closed) throw new Error("WISP network bridge is closed");
        if (endpointRevision !== this.#endpointRevision) {
          url = this.#url;
          previousUrl = undefined;
          failure = undefined;
          continue;
        }
        failure = toError(error);
        previousUrl = url;
        url = undefined;
        if (!this.#requestUrl) throw failure;
      }
    }
  }

  #openConnection(endpoint: URL): Promise<wisp.ClientConnection> {
    const connection = new wisp.ClientConnection(endpoint.href);
    this.#openingConnection = connection;
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectHandshake = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.#openingConnection === connection) {
          this.#openingConnection = undefined;
        }
        connection.close();
        reject(error);
      };
      connection.onopen = () => {
        if (this.#closed || this.#openingConnection !== connection) {
          rejectHandshake(
            new Error(
              this.#closed
                ? "WISP network bridge is closed"
                : "WISP endpoint changed while connecting",
            ),
          );
          return;
        }
        settled = true;
        if (this.#openingConnection === connection) {
          this.#openingConnection = undefined;
        }
        this.#url = endpoint.href;
        this.#connection = connection;
        resolve(connection);
      };
      connection.onerror = () => {
        rejectHandshake(new Error(`WISP connection to ${endpoint.href} failed`));
      };
      connection.onclose = () => {
        if (!settled) {
          rejectHandshake(
            new Error(
              `WISP connection to ${endpoint.href} closed before its handshake completed`,
            ),
          );
          return;
        }
        if (this.#connection === connection) this.#connection = undefined;
        this.#closeSockets();
      };
    });
  }

  #requireSocket(id: number): SocketState {
    const state = this.#sockets.get(id);
    if (!state) throw new Error(`unknown WISP socket ${id}`);
    return state;
  }

  #closeSockets(): void {
    for (const [id, state] of this.#sockets) {
      state.ended = true;
      this.#emitWake(id, "close");
    }
  }

  #emitWake(id: number, event: string): void {
    if (this.#closed) return;
    if (!this.#wake(id, event)) {
      setTimeout(() => this.#emitWake(id, event), 0);
    }
  }

  #rememberResolvedHost(host: string, addresses: readonly string[]): void {
    for (const address of addresses) {
      this.#resolvedHosts.set(stripIpv6Brackets(address), host);
    }
  }
}

async function resolveIpAddresses(
  dnsEndpoint: URL,
  hostname: string,
): Promise<{ addresses: string[]; ttlSeconds: number }> {
  // WISP stream creation has no TCP-open acknowledgement, so an unreachable
  // first address surfaces later as a write failure. Prefer IPv4 because
  // browser-facing WISP deployments commonly have no IPv6 route.
  const results = await Promise.allSettled([
    resolveDnsType(dnsEndpoint, hostname, 1),
    resolveDnsType(dnsEndpoint, hostname, 28),
  ]);
  const answers = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (answers.length === 0) {
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw failure?.reason ?? new Error(`DNS query for ${hostname} returned no addresses`);
  }
  const addresses = [...new Set(answers.map((answer) => answer.address))];
  const ttlSeconds = Math.min(300, ...answers.map((answer) => answer.ttlSeconds));
  return { addresses, ttlSeconds };
}

async function resolveDnsType(
  dnsEndpoint: URL,
  hostname: string,
  type: 1 | 28,
): Promise<Array<{ address: string; ttlSeconds: number }>> {
  const url = new URL(dnsEndpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type === 1 ? "A" : "AAAA");
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
  });
  if (!response.ok) {
    throw new Error(`DNS query failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    Status?: unknown;
    Answer?: Array<{ type?: unknown; TTL?: unknown; data?: unknown }>;
  };
  if (body.Status !== 0) {
    throw new Error(`DNS query for ${hostname} failed with status ${String(body.Status)}`);
  }
  return (body.Answer ?? []).filter(
    (answer) =>
      answer.type === type &&
      typeof answer.data === "string" &&
      (type === 1 ? isIpv4(answer.data) : isIpv6(answer.data)),
  ).map((answer) => ({
    address: answer.data as string,
    ttlSeconds:
      typeof answer.TTL === "number" && Number.isFinite(answer.TTL)
        ? Math.max(1, answer.TTL)
        : 60,
  }));
}

export function installWispNetworkGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__wasmerHostResolve = (bridgeId: number, host: string) =>
    bridgeFor(bridgeId).resolve(host);
  scope.__wasmerHostConnectTcp = (
    bridgeId: number,
    local: string,
    peer: string,
  ) => bridgeFor(bridgeId).connectTcp(local, peer);
  scope.__wasmerHostSocketRead = (bridgeId: number, id: number, maximum: number) =>
    bridgeFor(bridgeId).socketRead(id, maximum);
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
  scope.__wasmerHandleNetworkRpc = (value: unknown) => {
    if (!isNetworkRequest(value)) return false;
    void respondToNetworkRequest(value);
    return true;
  };
}

async function respondToNetworkRequest(request: NetworkRequest): Promise<void> {
  const control = new Int32Array(request.response, 0, 4);
  const payload = new Uint8Array(request.response, NETWORK_RPC_CONTROL_BYTES);
  try {
    const bridge = bridgeFor(request.bridgeId) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const method = bridge[request.method]!;
    const result = await method.apply(bridge, request.args);
    encodeResult(control, payload, result);
  } catch (error) {
    console.error(`[wasmer-wisp] ${request.method} failed`, error);
    control[1] = 5;
    control[2] = writeText(payload, String(error), true);
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function encodeResult(control: Int32Array, payload: Uint8Array, result: unknown): void {
  if (result === undefined) {
    control[1] = 3;
  } else if (result === null) {
    control[1] = 4;
  } else if (result instanceof Uint8Array) {
    if (result.byteLength > payload.byteLength) {
      throw new Error("WISP network response exceeds its worker mailbox");
    }
    control[1] = 2;
    control[2] = result.byteLength;
    payload.set(result);
  } else {
    control[1] = 1;
    control[2] = writeText(payload, JSON.stringify(result), false);
  }
}

function writeText(destination: Uint8Array, value: string, truncate: boolean): number {
  const encoded = new TextEncoder().encode(value);
  if (!truncate && encoded.byteLength > destination.byteLength) {
    throw new Error("WISP network response exceeds its worker mailbox");
  }
  const length = Math.min(encoded.byteLength, destination.byteLength);
  destination.set(encoded.subarray(0, length));
  return length;
}

function bridgeFor(id: number): WispNetworkBridge {
  const bridge = bridges.get(id);
  if (!bridge) throw new Error(`unknown or closed WISP network bridge ${id}`);
  return bridge;
}

function isNetworkRequest(value: unknown): value is NetworkRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "wasmer-network-rpc"
  );
}

function validateWispUrl(value: string): URL {
  const endpoint = new URL(value, globalThis.location?.href);
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new TypeError("WISP endpoint must use ws: or wss:");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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

function formatAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isIpAddress(host: string): boolean {
  const value = stripIpv6Brackets(host);
  return isIpv4(value) || value.includes(":");
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isIpv6(value: string): boolean {
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}
