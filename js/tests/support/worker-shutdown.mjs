import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

// A pooled worker asked to shut down exits from its message loop: it reports
// the exit and closes, even with a task still pending, and never calls back
// into the SDK. The pool frees its TLS and stack once it sees "exited".
const events = [];
globalThis.addEventListener = () => {};
globalThis.postMessage = message => events.push(message.type);
globalThis.close = () => events.push("close");
globalThis.reportError = error => { throw error; };
globalThis.record = event => events.push(event);
await import("../../dist/browser-worker.js");
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
  export default async function () {
    return {
      __wbindgen_thread_destroy() { globalThis.record('destroy'); },
      __tls_base: { value: 64 },
      __stack_alloc: { value: 128 },
    };
  }
  export class ThreadPoolWorker {
    constructor(id, gate, tlsBase, stackAlloc) {
      globalThis.record(\`new \${id} \${gate} \${tlsBase} \${stackAlloc}\`);
    }
    handle() { globalThis.record('task'); return new Promise(() => {}); }
    collectSharedObjects() { globalThis.record('collect'); }
    free() { globalThis.record('free'); }
  }
`);
globalThis.onmessage({ data: { type: "init", id: 3, sdkUrl, gate: 4096 } });
for (let turn = 0; turn < 5; turn++) await setImmediate();
globalThis.onmessage({ data: { type: "spawn-wasm" } });
await setImmediate();
globalThis.onmessage({ data: { type: "wasmer-shutdown" } });
await setImmediate();
assert.deepEqual(events, ["new 3 4096 64 128", "task", "exited", "close"]);
