import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { startNodeCompatibilityServer } from './support/serve-node-compat.mjs';

const browsers = { chromium, firefox, webkit };
for (const name of (process.env.WASMER_TEST_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  test(`Node compatibility, Express HTTP, cancellation and restart in ${name}`, { timeout: 240_000 }, async () => {
    assert(browsers[name], `Unknown browser: ${name}`);
    const server = await startNodeCompatibilityServer();
    let browser;
    try {
      browser = await browsers[name].launch({ headless: true, timeout: 30_000 });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); else if (message.type() === 'log') console.log(name + ': ' + message.text()); });
      await page.goto(server.url);
      const results = await page.evaluate(() => window.result);
      assert.equal(results.at(-1), 'PASS all Node compatibility checks');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
