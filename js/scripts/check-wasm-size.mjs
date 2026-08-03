import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = resolve(packageRoot, "pkg/wasmer_sdk_js_bg.wasm");
const maximumRawBytes = 8_500_000;
const maximumBrotliBytes = 1_800_000;

const rawBytes = statSync(wasmPath).size;
const brotliBytes = brotliCompressSync(readFileSync(wasmPath), {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
  },
}).byteLength;

console.log(
  `Wasm size: ${format(rawBytes)} raw, ${format(brotliBytes)} Brotli`,
);

const failures = [];
if (rawBytes > maximumRawBytes) {
  failures.push(`raw limit is ${format(maximumRawBytes)}`);
}
if (brotliBytes > maximumBrotliBytes) {
  failures.push(`Brotli limit is ${format(maximumBrotliBytes)}`);
}

if (failures.length > 0) {
  throw new Error(`The JS Wasm artifact exceeds its size budget: ${failures.join(", ")}`);
}

function format(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
