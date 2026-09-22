import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

const sourcePath = fileURLToPath(
  new URL("../src/browser-compatibility.ts", import.meta.url),
);
const source = await readFile(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const compatibility = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const { detectBrowserCompatibilityWarning } = compatibility;

const userAgents = {
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
  iosFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/153.0 Mobile/15E148 Safari/605.1.15",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/137.0.0.0 Mobile/15E148 Safari/604.1",
  unknown: "Unknown browser",
};
const jspi = { Suspending() {}, promising() {} };

test("does not warn any browser when both JSPI APIs are available", () => {
  for (const userAgent of Object.values(userAgents)) {
    assert.equal(detectBrowserCompatibilityWarning(userAgent, jspi), undefined);
  }
  assert.equal(detectBrowserCompatibilityWarning(userAgents.safari, jspi, 5), undefined);
});

test("requires both JSPI APIs to be functions, regardless of browser version", () => {
  for (const wasm of [
    {},
    { Suspending() {} },
    { promising() {} },
    { Suspending: true, promising() {} },
    { Suspending() {}, promising: true },
  ]) {
    for (const userAgent of Object.values(userAgents)) {
      const warning = detectBrowserCompatibilityWarning(userAgent, wasm);
      assert.equal(warning?.title, "Browser update required");
      assert.match(warning?.message ?? "", /missing WebAssembly JSPI/);
      assert.match(warning?.message ?? "", /reload this page/);
    }
  }
});

test("reads the current WebAssembly capabilities by default, including absent WebAssembly", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
  t.after(() => Object.defineProperty(globalThis, "WebAssembly", descriptor));
  for (const wasm of [jspi, {}, undefined]) {
    Object.defineProperty(globalThis, "WebAssembly", { ...descriptor, value: wasm });
    assert.equal(Boolean(detectBrowserCompatibilityWarning(userAgents.firefox)), wasm !== jspi);
  }
});

test("gives desktop browsers their minimum supported versions", () => {
  for (const [agent, browser, version] of [
    ["firefox", "firefox", /Firefox to version 153/],
    ["chrome", "chromium", /Chrome or Edge 137/],
    ["edge", "chromium", /Chrome or Edge 137/],
    ["safari", "safari", /Safari 27/],
  ]) {
    const warning = detectBrowserCompatibilityWarning(userAgents[agent], {});
    assert.equal(warning?.browser, browser);
    assert.match(warning.message, version);
  }
  const safari = detectBrowserCompatibilityWarning(userAgents.safari, {});
  assert.match(safari.message, /macOS Golden Gate/);
  assert.match(safari.message, /also available on macOS Tahoe and Sequoia/);
});

test("recommends an OS update for all iOS browsers and desktop-mode iPads", () => {
  for (const [userAgent, maxTouchPoints] of [
    [userAgents.iosSafari, 5],
    [userAgents.iosFirefox, 5],
    [userAgents.iosChrome, 5],
    [userAgents.iosSafari.replace("iPhone", "iPad"), 5],
    [userAgents.safari, 5],
  ]) {
    const warning = detectBrowserCompatibilityWarning(userAgent, {}, maxTouchPoints);
    assert.equal(warning?.browser, "ios");
    assert.match(warning.message, /iOS 27 or iPadOS 27/);
    assert.match(warning.message, /Settings > General > Software Update/);
  }
});

test("gives unknown browsers upgrade options instead of assuming support", () => {
  const warning = detectBrowserCompatibilityWarning(userAgents.unknown, {});
  assert.equal(warning?.browser, "unknown");
  assert.match(warning.message, /Firefox 153\+/);
  assert.match(warning.message, /Chrome 137\+/);
  assert.match(warning.message, /Safari 27\+/);
});
