/*
 * Cross-origin control document for a standalone Wasmer HTTP host.
 *
 * Serve a document importing this module at `/.wasmer/host.html` and the
 * service worker at `/wasmer-service-worker.js`.
 */

const CONNECT = "wasmer-sdk:http-host-connect";
const READY = "wasmer-sdk:http-host-ready";
const ERROR = "wasmer-sdk:http-host-error";

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
    const registration = await navigator.serviceWorker.register(
      "/wasmer-service-worker.js",
      { scope: "/", type: "module" },
    );
    await navigator.serviceWorker.ready;
    const worker =
      registration.active ?? registration.waiting ?? registration.installing;
    if (!worker) throw new Error("the Wasmer service worker is unavailable");
    if (worker.state !== "activated") await waitForActivation(worker);

    connection.addEventListener("message", (event: MessageEvent<unknown>) => {
      worker.postMessage(event.data, [...event.ports]);
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

function waitForActivation(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("the Wasmer service worker became redundant"));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}
