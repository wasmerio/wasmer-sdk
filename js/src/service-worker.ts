/*
 * Browser HTTP ingress for @wasmer/sdk2.
 *
 * Import this module from a same-origin service worker registered with scope
 * `/`. It deliberately has no dependency on the Wasmer runtime: the worker
 * only transports Fetch requests to a page-owned sandbox over MessagePort.
 */

interface RegisterMessage {
  type: "wasmer-sdk:http-register";
  serverId: string;
  path: string;
}

interface CloseMessage {
  type: "wasmer-sdk:http-close";
  serverId: string;
}

interface ResponseMessage {
  type: "wasmer-sdk:http-response";
  serverId: string;
  requestId: string;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  body?: Uint8Array;
  error?: string;
}

interface Route {
  id: string;
  path: string;
  port: MessagePort;
  pending: Map<string, PendingResponse>;
}

interface PendingResponse {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ServiceWorkerMessageEvent extends Event {
  data: unknown;
  ports: readonly MessagePort[];
}

interface ServiceWorkerFetchEvent extends Event {
  request: Request;
  clientId: string;
  resultingClientId: string;
  respondWith(response: Promise<Response> | Response): void;
}

interface ServiceWorkerLifecycleEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

const scope = globalThis as unknown as WorkerScope;
const routes = new Map<string, Route>();
const clients = new Map<string, string>();
const REQUEST_TIMEOUT_MS = 60_000;

scope.addEventListener("install", ((event: ServiceWorkerLifecycleEvent) => {
  event.waitUntil(scope.skipWaiting());
}) as (event: never) => void);

scope.addEventListener("activate", ((event: ServiceWorkerLifecycleEvent) => {
  event.waitUntil(scope.clients.claim());
}) as (event: never) => void);

scope.addEventListener("message", ((event: ServiceWorkerMessageEvent) => {
  const message = event.data as Partial<RegisterMessage | CloseMessage> | null;
  if (!message || typeof message !== "object") return;
  if (message.type === "wasmer-sdk:http-register") {
    const port = event.ports[0];
    if (!port || typeof message.serverId !== "string" || typeof message.path !== "string") {
      return;
    }
    closeRoute(message.serverId);
    const route: Route = {
      id: message.serverId,
      path: normalizePath(message.path),
      port,
      pending: new Map(),
    };
    routes.set(route.id, route);
    port.addEventListener("message", (responseEvent: MessageEvent<unknown>) => {
      receiveResponse(route, responseEvent.data);
    });
    port.start();
    port.postMessage({
      type: "wasmer-sdk:http-ready",
      serverId: route.id,
    });
  }
}) as (event: never) => void);

scope.addEventListener("fetch", ((event: ServiceWorkerFetchEvent) => {
  const url = new URL(event.request.url);
  let route = [...routes.values()].find((candidate) =>
    url.pathname.startsWith(candidate.path),
  );
  let path = url.pathname + url.search;

  if (route) {
    const suffix = url.pathname.slice(route.path.length);
    path = `/${suffix}${url.search}`;
  } else if (event.clientId) {
    const routeId = clients.get(event.clientId);
    route = routeId ? routes.get(routeId) : undefined;
  }

  if (!route) return;
  if (event.resultingClientId) clients.set(event.resultingClientId, route.id);
  event.respondWith(forwardRequest(route, event.request, path));
}) as (event: never) => void);

async function forwardRequest(
  route: Route,
  request: Request,
  path: string,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const body = new Uint8Array(await request.arrayBuffer());
  const response = new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      route.pending.delete(requestId);
      reject(new Error(`guest HTTP request exceeded ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    route.pending.set(requestId, { resolve, reject, timer });
  });
  route.port.postMessage(
    {
      type: "wasmer-sdk:http-request",
      serverId: route.id,
      requestId,
      method: request.method,
      path,
      headers: [...request.headers.entries()],
      body,
    },
    [body.buffer],
  );
  try {
    return await response;
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

function receiveResponse(route: Route, value: unknown): void {
  const message = value as Partial<ResponseMessage | CloseMessage> | null;
  if (
    !message ||
    message.type !== "wasmer-sdk:http-response" ||
    message.serverId !== route.id ||
    typeof message.requestId !== "string"
  ) {
    if (message?.type === "wasmer-sdk:http-close" && message.serverId === route.id) {
      closeRoute(route.id);
    }
    return;
  }
  const pending = route.pending.get(message.requestId);
  if (!pending) return;
  route.pending.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.error) {
    pending.reject(new Error(message.error));
    return;
  }
  const status = message.status ?? 502;
  const bodyAllowed = status >= 200 && status !== 204 && status !== 205 && status !== 304;
  const body = message.body ? Uint8Array.from(message.body).buffer : null;
  const headers = new Headers(message.headers);
  // Preserve cross-origin isolation when the host page uses SharedArrayBuffer.
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  pending.resolve(
    new Response(bodyAllowed ? body : null, {
      status,
      statusText: message.statusText,
      headers,
    }),
  );
}

function closeRoute(id: string): void {
  const route = routes.get(id);
  if (!route) return;
  routes.delete(id);
  for (const [clientId, routeId] of clients) {
    if (routeId === id) clients.delete(clientId);
  }
  for (const pending of route.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("the Wasmer browser server was closed"));
  }
  route.pending.clear();
  route.port.close();
}

function normalizePath(path: string): string {
  const leading = path.startsWith("/") ? path : `/${path}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}
