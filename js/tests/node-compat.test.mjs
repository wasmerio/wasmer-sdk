import assert from "node:assert/strict";
import test from "node:test";
import { installNodeSymbols, installNodeStackTrace } from "../dist/node-compat.js";

test("missing disposal symbols support Node's primordial getter and remain stable", () => {
  const symbol = (description) => Symbol(description);
  assert.deepEqual(installNodeSymbols(symbol), ["dispose", "asyncDispose"]);
  const getter = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get;
  assert.equal(getter.call(symbol.asyncDispose), "Symbol.asyncDispose");
  assert.equal(getter.call(symbol.dispose), "Symbol.dispose");
  const first = symbol.asyncDispose;
  assert.deepEqual(installNodeSymbols(symbol), []);
  assert.equal(symbol.asyncDispose, first);
  assert.equal(Object.getOwnPropertyDescriptor(symbol, "dispose").writable, false);
  assert.deepEqual(Object.keys(symbol), []);
});

test("existing host symbols retain their identity", () => {
  const dispose = Symbol.dispose;
  const asyncDispose = Symbol.asyncDispose;
  installNodeSymbols();
  assert.equal(Symbol.dispose, dispose);
  assert.equal(Symbol.asyncDispose, asyncDispose);
});

function jscError() {
  class HostError {}
  HostError.captureStackTrace = target => {
    target.stack = "getStack@\ndepd@http://localhost:8000/send.js:109:12\n@/app/server.js:7:3\nnativeCall@[native code]";
  };
  return HostError;
}

test("captureStackTrace supports depd's temporary structured-stack formatter", () => {
  const HostError = jscError();
  const formatter = () => "original";
  HostError.prepareStackTrace = formatter;
  assert.equal(installNodeStackTrace(HostError), true);
  assert.equal(HostError.prepareStackTrace, formatter);
  assert.equal(installNodeStackTrace(HostError), false);
  HostError.prepareStackTrace = (_error, frames) => frames;
  const target = {};
  HostError.captureStackTrace(target);
  const frames = target.stack;
  HostError.prepareStackTrace = formatter;
  assert.equal(target.stack, frames);
  assert.equal(frames[0].getFileName(), null);
  assert.equal(frames[1].getFileName(), "http://localhost:8000/send.js");
  assert.equal(frames[1].getLineNumber(), 109);
  assert.equal(frames[1].getColumnNumber(), 12);
  assert.equal(frames[1].getFunctionName(), "depd");
  assert.equal(frames[1].isEval(), false);
  assert.equal(frames[1].getThis(), undefined);
  assert.equal(frames[2].isToplevel(), true);
  assert.equal(frames[3].isNative(), true);
  assert.equal(Object.getOwnPropertyDescriptor(target, "stack").enumerable, false);
});

test("fallback stack formatting is lazy, bounded, writable, and hides constructor frames", () => {
  class HostError {
    constructor() { this.stack = "captureStackTrace@shim.js:1:1\nCustomError@/app.js:2:1\ncaller@/app.js:3:2\nouter@/app.js:4:1"; }
  }
  installNodeStackTrace(HostError);
  HostError.stackTraceLimit = 1;
  const target = { name: "CustomError", message: "failed" };
  HostError.captureStackTrace(target, function CustomError() {});
  assert.equal(target.stack, "CustomError: failed\n    at caller (/app.js:3:2)");
  target.stack = "replacement";
  assert.equal(target.stack, "replacement");
  HostError.stackTraceLimit = 0;
  HostError.captureStackTrace(target);
  HostError.prepareStackTrace = (_error, frames) => frames;
  assert.deepEqual(target.stack, []);
  assert.throws(() => HostError.captureStackTrace(null), TypeError);
});

test("V8 keeps its native stack trace API and existing formatter descriptor", () => {
  const capture = Error.captureStackTrace;
  const descriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  assert.equal(installNodeStackTrace(), false);
  assert.equal(Error.captureStackTrace, capture);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), descriptor);
});
