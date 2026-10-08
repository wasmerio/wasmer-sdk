// Copies what the windows example compiles into its workspace: the header of
// Wasmer's GUI (packages/gui) and its example program, and the guest half of
// Wasmer's WebGPU (packages/webgpu), which the program draws with. The
// example compiles them in the browser, so it carries them as source.
//
//     node scripts/sync-gui-example.mjs           update workspace/gui
//     node scripts/sync-gui-example.mjs --check   fail if it is out of date

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const gui = new URL("../../packages/gui/", import.meta.url);
const webgpu = new URL("../../packages/webgpu/", import.meta.url);
const example = new URL("../workspace/gui/", import.meta.url);
/** Whole directories: what is no longer in the source goes from the copy. */
const directories = [
  [gui, "include/wasmer/", "include/wasmer/", (name) => name === "gui.h"],
  [webgpu, "include/webgpu/", "include/webgpu/", () => true],
  [webgpu, "guest/src/", "lib/", () => true],
];
const files = [[gui, "examples/triangle.c", "triangle.c"]];
const check = process.argv.includes("--check");

// packages/webgpu is a submodule, and packages/gui may be one: a checkout
// without them has nothing to compare with.
if (
  check &&
  !(existsSync(new URL("include/wasmer/gui.h", gui)) && existsSync(new URL("include/webgpu/webgpu.h", webgpu)))
) {
  console.log("packages/gui or packages/webgpu is not checked out: workspace/gui was not compared");
  process.exit(0);
}

const stale = [];
async function copy(source, destination, label) {
  const contents = await readFile(source);
  const current = await readFile(destination).catch(() => null);
  if (current?.equals(contents)) return;
  stale.push(label);
  if (!check) await writeFile(destination, contents);
}

for (const [root, from, to, wanted] of directories) {
  const source = new URL(from, root);
  const destination = new URL(to, example);
  const names = (await readdir(source)).filter(wanted).sort();
  const present = await readdir(destination).catch(() => []);
  for (const name of present) {
    if (names.includes(name)) continue;
    stale.push(`${to}${name} (no longer in its source)`);
    if (!check) await rm(new URL(name, destination));
  }
  if (!check) await mkdir(destination, { recursive: true });
  for (const name of names) {
    await copy(new URL(name, source), new URL(name, destination), `${to}${name}`);
  }
}
for (const [root, from, to] of files) {
  await copy(new URL(from, root), new URL(to, example), to);
}

if (stale.length === 0) {
  console.log("workspace/gui matches packages/gui and packages/webgpu");
} else if (check) {
  console.error(`${fileURLToPath(example)} is out of date:\n  ${stale.join("\n  ")}`);
  console.error("Run: node scripts/sync-gui-example.mjs");
  process.exitCode = 1;
} else {
  console.log(`updated:\n  ${stale.join("\n  ")}`);
}
