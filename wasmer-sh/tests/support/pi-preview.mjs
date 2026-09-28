import assert from 'node:assert/strict';

// Expose terminal state in this test page only, without extending the app API.
export async function instrumentPiPage(page) {
  await page.route(/\/src\/main\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) +
      '\nwindow.__piTest = { terminal, get session() { return activeSession; } };\n' });
  });
}

export async function preparePiPreview(page) {
  await page.evaluate(async () => {
    // An upstream Pi extension observes resize events; it does not refresh
    // dimensions or send signals itself, which would hide SDK regressions.
    await window.__piTest.session.sandbox.fs.writeText('pi-terminal-probe.mjs', `
import fs from 'node:fs';
export default function () {
  let signals = 0, resizes = 0;
  process.on('SIGWINCH', () => signals++);
  process.stdout.on('resize', () => resizes++);
  const save = () => {
    const raw = [];
    process.stdout._handle.getWindowSize(raw);
    fs.writeFileSync('/workspace/pi-terminal.json', JSON.stringify({
      cached: [process.stdout.columns, process.stdout.rows], raw, signals, resizes,
    }));
  };
  setInterval(save, 100).unref();
  save();
}
`);
  });
}

export async function checkPiPreview(page) {
  const send = text => page.evaluate(text => window.__wasmerShell.send(text), text);
  const probe = () => page.evaluate(async () =>
    JSON.parse(await window.__piTest.session.sandbox.fs.readText('pi-terminal.json')));
  const waitForSize = () => page.waitForFunction(async () => {
    const { terminal, session } = window.__piTest;
    const { cached, raw } = JSON.parse(await session.sandbox.fs.readText('pi-terminal.json'));
    return cached[0] === terminal.cols && cached[1] === terminal.rows &&
      raw[0] === terminal.cols && raw[1] === terminal.rows;
  }, undefined, { timeout: 15_000 });
  async function checkTyping() {
    const input = 'Now change something';
    for (const character of input) {
      await send(character);
      await page.waitForTimeout(40);
    }
    await page.waitForFunction(input => {
      const { terminal } = window.__piTest;
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
        .some(line => line.includes(input));
    }, input);
    const matches = await page.evaluate(() => {
      const { terminal } = window.__piTest;
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, row) =>
        buffer.getLine(row)?.translateToString(true) ?? '')
        .filter(line => line.includes('Now change'));
    });
    assert.equal(matches.length, 1, `Pi repeated editable input: ${JSON.stringify(matches)}`);
    assert(matches[0].includes(input));
    await send('\x03');
  }
  async function stopServer() {
    await page.evaluate(async () => {
      if (!window.__piTestServer) return;
      await window.__piTestServer.kill();
      await window.__piTestServer.wait();
      window.__piTestServer = undefined;
    });
    await page.waitForFunction(() => document.querySelector('#preview-panel').hidden);
  }

  try {
    await waitForSize();
    const before = await probe();
    // Opening, closing and reopening exercise foreground-child signal routing,
    // both resize directions, listener cleanup and a restart on the same port.
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(async () => {
        const sandbox = window.__piTest.session.sandbox;
        window.__piTestServer = await sandbox.command('node', ['-e', `
require('http').createServer((q, r) => {
  r.setHeader('Content-Type', 'text/plain'); r.end('PI_PREVIEW_OK');
}).listen(3000);
`]).spawn({ stdout: 'capture', stderr: 'capture' });
        await sandbox.ports.wait(3000);
      });
      await page.waitForFunction(() => !document.querySelector('#preview-panel').hidden);
      await page.waitForFunction(columns => window.__piTest.terminal.cols < columns, before.cached[0]);
      await waitForSize();
      await page.frameLocator('#preview-content iframe').frameLocator('iframe')
        .getByText('PI_PREVIEW_OK').waitFor();
      const requests = await page.evaluate(async () => {
        const output = await window.__piTest.session.sandbox.command('node', ['-e', `
const http = require('http');
(async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    await new Promise((resolve, reject) => {
      const req = http.get('http://' + host + ':3000/', { timeout: 3000 }, res => {
        let body = ''; res.on('data', b => body += b);
        res.on('end', () => { console.log(JSON.stringify({ host, status: res.statusCode, body })); resolve(); });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`]).run({ timeoutMs: 15_000, check: false });
        return { exitCode: output.exitCode, stdout: output.stdout.text(), stderr: output.stderr.text() };
      });
      assert.equal(requests.exitCode, 0, JSON.stringify(requests));
      const responses = requests.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(responses.length, 3);
      for (const response of responses) {
        assert.equal(response.status, 200, response.host);
        assert.equal(response.body, 'PI_PREVIEW_OK');
      }
      await checkTyping();
      await stopServer();
      await page.waitForFunction(columns => window.__piTest.terminal.cols === columns, before.cached[0]);
      await waitForSize();
      await checkTyping();
    }
    const after = await probe();
    assert(after.signals >= before.signals + 4, JSON.stringify({ before, after }));
    assert(after.resizes >= before.resizes + 4, JSON.stringify({ before, after }));
    assert.equal(await page.evaluate(() => window.__wasmerShell.snapshot().includes('preview opened')), false);
    console.log('PASS Pi preview: automatic resize, single-line typing, IPv4/localhost/IPv6 HTTP, stop and restart');
  } finally {
    await stopServer();
  }
}
