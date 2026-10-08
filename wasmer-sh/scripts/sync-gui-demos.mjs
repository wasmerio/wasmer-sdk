// Copies the programs this checkout has built on top of Wasmer's GUI
// (packages/gui/integrations) into the windows example, to try them in
// wasmer.sh as they are: SDL and winit programs are not compiled in the
// browser, so what is tried here is what was built outside it.
//
//     node scripts/sync-gui-demos.mjs           update workspace/gui/demos
//     node scripts/sync-gui-demos.mjs --clean   remove them again
//
// workspace/gui/demos is not in the repository: a wasmer.sh built without
// running this has no such directory, and its windows example is the one
// program it compiles itself.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const integrations = new URL("../../packages/gui/integrations/", import.meta.url);
const demos = new URL("../workspace/gui/demos/", import.meta.url);
/** [name in the shell, where it is built, what builds it, what it is] */
const programs = [
  [
    "imgui.wasm",
    "sdl3/imgui/out/imgui_demo.wasm",
    "make -C packages/gui imgui-demo",
    "Dear ImGui's SDL3 example, on SDL's software renderer",
  ],
  [
    "sdl-events.wasm",
    "sdl3/tests/out/sdl_events.wasm",
    "make -C packages/gui sdl-programs",
    "prints every SDL event; its function keys are listed in sdl_events.c",
  ],
  [
    "winit-window.wasm",
    "winit/example/out/window.wasm",
    "make -C packages/gui winit-programs",
    "winit's own `window` example; it logs its key bindings when it starts",
  ],
  [
    "winit-events.wasm",
    "winit/tests/out/winit_events.wasm",
    "make -C packages/gui winit-programs",
    "prints every winit event",
  ],
];

if (process.argv.includes("--clean")) {
  await rm(demos, { recursive: true, force: true });
  console.log(`removed ${fileURLToPath(demos)}`);
  process.exit(0);
}

await mkdir(demos, { recursive: true });
const wanted = new Set(programs.map(([name]) => name));
for (const name of await readdir(demos)) {
  // What is no longer on the list goes from the copy.
  if (!wanted.has(name)) await rm(new URL(name, demos), { recursive: true });
}
let copied = 0;
for (const [name, built, builtBy, what] of programs) {
  const source = new URL(built, integrations);
  if (!existsSync(source)) {
    await rm(new URL(name, demos), { force: true });
    console.log(`  ${name.padEnd(18)} not built (${builtBy})`);
    continue;
  }
  await copyFile(source, new URL(name, demos));
  copied += 1;
  const megabytes = ((await stat(source)).size / 1_000_000).toFixed(1);
  console.log(`  ${name.padEnd(18)} ${megabytes} MB  ${what}`);
}
console.log(
  copied > 0
    ? `\n${copied} programs in workspace/gui/demos. In wasmer.sh, open "Windows and input" and run one: ./demos/imgui.wasm`
    : "\nNothing to copy: build the programs first.",
);
