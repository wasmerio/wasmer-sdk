// Serves the WebGPU browser example with a guest built from
// packages/webgpu/examples/triangle.c (`make -C packages/webgpu examples`).
import { readFile } from 'node:fs/promises';
import { startAppServer } from '../tests/support/browser-servers.mjs';

const guest = new URL('../../packages/webgpu/examples/out/triangle.wasm', import.meta.url);
let triangle;
try {
  triangle = await readFile(guest);
} catch {
  console.error('Build the guest first: make -C packages/webgpu examples');
  process.exit(1);
}
const host = await startAppServer({ files: { '/examples/triangle.wasm': triangle } });
console.log(new URL('/examples/webgpu-browser.html', host.url).href);
process.on('SIGINT', async () => { await host.close(); process.exit(0); });
