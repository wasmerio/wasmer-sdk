/*
 * Browser HTTP ingress for @wasmer/sdk.
 *
 * Import this module from a same-origin service worker registered with scope
 * `/`. It deliberately has no dependency on the Wasmer runtime: the worker
 * only transports Fetch requests to a page-owned sandbox over MessagePort.
 */

interface RegisterMessage {
  type: "wasmer-sdk:http-register";
  serverId: string;
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
let activeRoute: Route | undefined;
const REQUEST_TIMEOUT_MS = 300_000;

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
    if (!port || typeof message.serverId !== "string") {
      return;
    }
    if (activeRoute) {
      port.postMessage({
        type: "wasmer-sdk:http-error",
        serverId: message.serverId,
        error: "this service worker already exposes another guest server",
      });
      port.close();
      return;
    }
    const route: Route = {
      id: message.serverId,
      port,
      pending: new Map(),
    };
    activeRoute = route;
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
  // Keep the cross-origin control document reachable while the guest owns `/`.
  if (url.pathname.startsWith("/.wasmer/")) return;
  const route = activeRoute;
  if (!route) return;
  event.respondWith(
    forwardRequest(route, event.request, url.pathname + url.search),
  );
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
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "cross-origin",
      },
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
  // The HTTP host may live on a dedicated origin and be embedded by the app.
  headers.set("cross-origin-resource-policy", "cross-origin");
  pending.resolve(
    new Response(bodyAllowed ? body : null, {
      status,
      statusText: message.statusText,
      headers,
    }),
  );
}

function closeRoute(id: string): void {
  const route = activeRoute;
  if (!route || route.id !== id) return;
  activeRoute = undefined;
  for (const pending of route.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("the Wasmer browser server was closed"));
  }
  route.pending.clear();
  route.port.close();
}
