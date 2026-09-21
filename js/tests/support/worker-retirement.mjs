import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

const events = [];
let complete;
globalThis.addEventListener = () => {};
globalThis.postMessage = message => events.push(message.type);
globalThis.close = () => events.push("close");
globalThis.reportError = error => { throw error; };
globalThis.beginTask = () => new Promise(resolve => { complete = resolve; });
globalThis.record = event => events.push(event);
await import("../../dist/browser-worker.js");
const sdkUrl = "data:text/javascript," + encodeURIComponent(`
  export default async function () { return { __wbindgen_thread_destroy() { globalThis.record('destroy'); } }; }
  export class ThreadPoolWorker {
    handle() { return globalThis.beginTask(); }
    collectSharedObjects() { globalThis.record('collect'); }
    free() { globalThis.record('free'); }
  }
`);
globalThis.onmessage({data:{type:"init",id:1,sdkUrl,retireAfterTask:true}});
await setImmediate();
globalThis.onmessage({data:{type:"spawn-wasm"}});
await setImmediate();
assert.equal(typeof complete,"function");
assert.deepEqual(events,[],"must not retire a suspended guest");
complete();
await setImmediate();
assert.deepEqual(events,["collect","free","destroy","retired","close"]);
