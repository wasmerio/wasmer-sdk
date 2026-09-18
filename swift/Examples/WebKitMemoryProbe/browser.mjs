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
  initial: { type: 'string', default: '133' },
  maximum: { type: 'string', default: '2048' },
  'receiver-access': { type: 'string', default: 'buffer' },
  probe: { type: 'string', default: 'allocation' },
  'gc-mode': { type: 'string', default: 'none' },
} });
if (!['allocation', 'collection'].includes(values.probe)
    || !['none', 'producer', 'receivers'].includes(values['gc-mode']))
  throw new Error('Invalid probe or gc-mode option');
const files = new Map([
  ['/index.html', 'text/html'], ['/producer.js', 'text/javascript'],
  ['/consumer.js', 'text/javascript'],
  ['/collection.js', 'text/javascript'], ['/collection-producer.js', 'text/javascript'],
  ['/collection-consumer.js', 'text/javascript'],
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
  browser = await chromium.launch({ headless: true,
    args: values.probe === 'collection' ? ['--js-flags=--expose-gc'] : [] });
  const page = await browser.newPage();
  const query = new URLSearchParams({ mode: values.mode, workers: values.workers,
    iterations: values.iterations, delayMs: values['delay-ms'],
    recycleEvery: values['recycle-every'], initial: values.initial, maximum: values.maximum,
    receiverAccess: values['receiver-access'], probe: values.probe, gcMode: values['gc-mode'] });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${query}`);
  await page.waitForFunction(() => globalThis.probeResult, null, { timeout: 180_000 });
  const result = await page.evaluate(() => globalThis.probeResult);
  result.browserVersion = browser.version();
  const session = await browser.newBrowserCDPSession();
  result.jsVersion = (await session.send('Browser.getVersion')).jsVersion;
  const directory = new URL('./Artifacts/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const variant = result.probe === 'collection' ? `collection-${result.gcMode}`
    : `${result.mode}-initial${result.initial}-max${result.maximum}-${result.receiverAccess}`
      + `-delay${result.delayMs}-recycle${result.recycleEvery}`;
  await writeFile(new URL(`chromium-${result.workers}-${variant}.json`, directory), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
