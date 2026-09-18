// Uses the same assets and allocation loop as the iOS probe.
import { chromium } from '../../../wasmer-sh/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'shared' },
  workers: { type: 'string', default: '20' },
  iterations: { type: 'string', default: '2000' },
  'delay-ms': { type: 'string', default: '0' },
  'recycle-every': { type: 'string', default: '0' },
} });
const files = new Map([
  ['/index.html', 'text/html'], ['/producer.js', 'text/javascript'],
  ['/consumer.js', 'text/javascript'],
]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (!files.has(path)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(`./Web${path}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': files.get(path), 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store',
    }).end(body);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const query = new URLSearchParams({ mode: values.mode, workers: values.workers,
    iterations: values.iterations, delayMs: values['delay-ms'],
    recycleEvery: values['recycle-every'] });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${query}`);
  await page.waitForFunction(() => globalThis.probeResult, null, { timeout: 180_000 });
  const result = await page.evaluate(() => globalThis.probeResult);
  result.browserVersion = browser.version();
  const directory = new URL('./Artifacts/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`chromium-${result.mode}-${result.workers}-delay${result.delayMs}-recycle${result.recycleEvery}.json`, directory), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
