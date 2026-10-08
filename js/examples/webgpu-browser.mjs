// Serve this repository's js/ directory with COOP/COEP headers (see README).
import { Wasmer } from "../dist/index.js";

/**
 * Run the triangle guest (packages/webgpu/examples/triangle.c) with `canvas`
 * as what it presents to. It draws until it is stopped.
 */
export async function startTriangle(canvas) {
  const wasmer = new Wasmer();
  let sandbox;
  async function close() {
    await sandbox?.close();
    await wasmer.close();
  }
  try {
    const bytes = new Uint8Array(await (await fetch(new URL("./triangle.wasm", import.meta.url))).arrayBuffer());
    const guest = await wasmer.packages.load(bytes);
    // The guest names its target "#canvas"; `canvas` answers for every name.
    sandbox = await wasmer.sandboxes.create({ packages: [guest], webgpu: { canvas } });
    const process = await sandbox.command(guest).spawn({ stdout: "capture", stderr: "capture" });
    return {
      done: process.wait({ check: false }),
      stop: () => process.kill(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
