import assert from "node:assert/strict";
import test from "node:test";
import { installNodeSymbols } from "../Sources/WasmerWKSDK/Web/node-compat.js";

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
