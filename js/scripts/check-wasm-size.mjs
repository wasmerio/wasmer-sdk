import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = resolve(packageRoot, "pkg/wasmer_sdk_js_bg.wasm");
// Raised from 5.00 MB for the allocator-gated worker termination
// (wasmer-sdk#542/#556), then for the GUI and WebGPU browser runtime, then
// for main's worker retirement and guest memory budget (#578-#583) on top of
// it: about 5.40 MB once main was merged into webgpu-gui.
const maximumRawBytes = 5_450_000;
const maximumBrotliBytes = 1_500_000;

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
