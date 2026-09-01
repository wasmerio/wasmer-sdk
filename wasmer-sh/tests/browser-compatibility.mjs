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

test("shows the Firefox compatibility warning", () => {
  const warning = detectBrowserCompatibilityWarning(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
  );
  assert.equal(warning?.browser, "firefox");
  assert.match(warning?.message ?? "", /working on Firefox support/);
  assert.match(warning?.message ?? "", /use Chrome/);
});

test("shows the Safari JSPI compatibility warning", () => {
  const warning = detectBrowserCompatibilityWarning(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  );
  assert.equal(warning?.browser, "safari");
  assert.match(warning?.message ?? "", /does not support JSPI yet/);
  assert.match(warning?.message ?? "", /use Chrome/);
});

test("classifies Firefox on iOS as Firefox", () => {
  const warning = detectBrowserCompatibilityWarning(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
  );
  assert.equal(warning?.browser, "firefox");
});

test("does not warn Chromium browsers", () => {
  for (const userAgent of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  ]) {
    assert.equal(detectBrowserCompatibilityWarning(userAgent), undefined);
  }
});
