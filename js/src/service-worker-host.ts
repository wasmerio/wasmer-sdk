/*
 * Cross-origin control document for a standalone Wasmer HTTP host.
 *
 * Serve a document importing this module at `/.wasmer/host.html` and the
 * service worker at `/wasmer-service-worker.js`.
 */

const CONNECT = "wasmer-sdk:http-host-connect";
const READY = "wasmer-sdk:http-host-ready";
const ERROR = "wasmer-sdk:http-host-error";
const WORKER_URL = "/wasmer-service-worker.js";

let workerResolution: Promise<ServiceWorker> | undefined;

const expectedParentOrigin = new URLSearchParams(globalThis.location.search).get(
  "parentOrigin",
);

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as { type?: unknown } | null;
  if (
    message?.type !== CONNECT ||
    !expectedParentOrigin ||
    event.origin !== expectedParentOrigin
  ) {
    return;
  }
  const connection = event.ports[0];
  if (!connection) return;
  void connect(connection);
});

async function connect(connection: MessagePort): Promise<void> {
  try {
    await ensureActiveWorker(true);

    connection.addEventListener("message", (event: MessageEvent<unknown>) => {
      void forwardToWorker(event);
    });
    connection.start();
    connection.postMessage({ type: READY });
  } catch (error) {
    connection.postMessage({
      type: ERROR,
      error: error instanceof Error ? error.message : String(error),
    });
    connection.close();
  }
}

async function forwardToWorker(event: MessageEvent<unknown>): Promise<void> {
  try {
    const worker = await ensureActiveWorker(false);
    worker.postMessage(event.data, [...event.ports]);
  } catch (error) {
    // Route registration messages carry a response port. Returning the error on
    // it lets ports.expose() fail immediately instead of waiting for a timeout.
    const response = event.ports[0];
    if (!response) return;
    const message = event.data as { serverId?: unknown } | null;
    response.postMessage({
      type: "wasmer-sdk:http-error",
      serverId: typeof message?.serverId === "string" ? message.serverId : "",
      error: describeError(error),
    });
    response.close();
  }
}

function ensureActiveWorker(checkForUpdates: boolean): Promise<ServiceWorker> {
  if (!workerResolution) {
    workerResolution = resolveActiveWorker(checkForUpdates).finally(() => {
      workerResolution = undefined;
    });
  }
  return workerResolution;
}

async function resolveActiveWorker(
  checkForUpdates: boolean,
): Promise<ServiceWorker> {
  if (!checkForUpdates) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const active = registration?.active;
    if (active?.state === "activated") return active;
  }

  const registration = await navigator.serviceWorker.register(WORKER_URL, {
    scope: "/",
    type: "module",
    updateViaCache: "none",
  });
  try {
    return await activatedWorker(registration);
  } catch {
    // Chrome can retain a registration record after discarding all of its
    // workers. Remove that unusable record and install a fresh worker once.
    await registration.unregister();
    const recovered = await navigator.serviceWorker.register(
      `${WORKER_URL}?recovery=${Date.now()}`,
      { scope: "/", type: "module", updateViaCache: "none" },
    );
    return activatedWorker(recovered);
  }
}

async function activatedWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker> {
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;
  if (!worker || worker.state === "redundant") {
    throw new Error("the Wasmer service worker is unavailable");
  }
  if (worker.state !== "activated") await waitForActivation(worker);
  const active = registration.active ?? worker;
  if (active.state !== "activated") {
    throw new Error("the Wasmer service worker did not activate");
  }
  return active;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForActivation(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const onStateChange = () => {
      if (worker.state === "activated") {
        finish();
      } else if (worker.state === "redundant") {
        finish(new Error("the Wasmer service worker became redundant"));
      }
    };
    const timeout = setTimeout(
      () => finish(new Error("the Wasmer service worker did not activate")),
      15_000,
    );
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}
