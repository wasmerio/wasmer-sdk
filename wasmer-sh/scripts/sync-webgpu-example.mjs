// Copies the guest half of Wasmer's WebGPU (packages/webgpu) into the WebGPU
// example: the headers its programs include and the C sources they link.
// The example compiles them in the browser, so it carries them as source.
//
//     node scripts/sync-webgpu-example.mjs           update workspace/webgpu
//     node scripts/sync-webgpu-example.mjs --check   fail if it is out of date

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const webgpu = new URL("../../packages/webgpu/", import.meta.url);
const example = new URL("../workspace/webgpu/", import.meta.url);
const copies = [
  ["include/webgpu/", "include/webgpu/"],
  ["guest/src/", "lib/"],
];
const check = process.argv.includes("--check");

// packages/webgpu is a submodule: a checkout without it has nothing to
// compare with.
if (check && !existsSync(new URL("include/webgpu/webgpu.h", webgpu))) {
  console.log("packages/webgpu is not checked out: workspace/webgpu was not compared");
  process.exit(0);
}

const stale = [];
for (const [from, to] of copies) {
  const source = new URL(from, webgpu);
  const destination = new URL(to, example);
  const names = (await readdir(source)).sort();
  const present = await readdir(destination).catch(() => []);
  for (const name of present) {
    if (names.includes(name)) continue;
    stale.push(`${to}${name} (no longer in packages/webgpu)`);
    if (!check) await rm(new URL(name, destination));
  }
  if (!check) await mkdir(destination, { recursive: true });
  for (const name of names) {
    const contents = await readFile(new URL(name, source));
    const current = await readFile(new URL(name, destination)).catch(() => null);
    if (current?.equals(contents)) continue;
    stale.push(`${to}${name}`);
    if (!check) await writeFile(new URL(name, destination), contents);
  }
}

if (stale.length === 0) {
  console.log("workspace/webgpu matches packages/webgpu");
} else if (check) {
  console.error(`${fileURLToPath(example)} is out of date:\n  ${stale.join("\n  ")}`);
  console.error("Run: node scripts/sync-webgpu-example.mjs");
  process.exitCode = 1;
} else {
  console.log(`updated:\n  ${stale.join("\n  ")}`);
}
