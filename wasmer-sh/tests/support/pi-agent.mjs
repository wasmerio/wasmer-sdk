import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { preparePiPreview, checkPiPreview } from './pi-preview.mjs';

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// A deterministic OpenAI-compatible streaming endpoint exercises the real Pi
// agent/provider/tool loop without a provider account, paid calls, or API keys.
export async function startPiModelFixture() {
  const steps = [
    ['read', { path: 'hello.js' }, 'greet'],
    ['write', { path: 'pi-test/result.txt', content: 'before\n' }, 'Successfully'],
    ['edit', { path: 'pi-test/result.txt', oldText: 'before', newText: 'after' }, 'Successfully'],
    ['bash', { command: 'node hello.js && cat pi-test/result.txt' }, 'Hello, Wasmer!'],
    ['grep', { pattern: 'after', path: 'pi-test' }, 'after'],
    ['find', { pattern: '*.txt', path: 'pi-test' }, 'result.txt'],
    ['ls', { path: 'pi-test' }, 'result.txt'],
  ];
  let requests = 0;
  const errors = [];
  const model = http.createServer(async (request, response) => {
    try {
      if (request.url === '/health') { response.end('ok'); return; }
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer test-only-not-a-secret');
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.stream, true);
      if (requests > 0) {
        const previous = input.messages.filter(message => message.role === 'tool').at(-1);
        assert(previous, 'Pi did not send a tool result');
        const text = typeof previous.content === 'string' ? previous.content : JSON.stringify(previous.content);
        assert(text.includes(steps[requests - 1][2]), `Unexpected ${steps[requests - 1][0]} result: ${text}`);
        if (steps[requests - 1][0] === 'bash') assert(text.includes('after'), text);
      }
      const step = steps[requests++];
      if (step) assert(input.tools.some(tool => tool.function.name === step[0]));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: `wasmer-test-${requests}`, object: 'chat.completion.chunk', created: 1,
        model: 'test', choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      send({ role: 'assistant' });
      if (step) {
        send({ tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: {
          name: step[0], arguments: JSON.stringify(step[1]),
        } }] });
        send({}, 'tool_calls');
      } else {
        send({ content: 'PI_AGENT_' });
        send({ content: 'TOOLS_OK' });
        send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error.message);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message, type: 'invalid_request_error' } }));
    }
  });
  // Guest loopback belongs to the sandbox. Reach the host fixture over WISP
  // using a host interface instead, and allow private IPs only for this test.
  const address = Object.values(networkInterfaces()).flat().find(info => info.family === 'IPv4' && !info.internal)?.address;
  assert(address, 'Pi test requires a non-loopback IPv4 interface');
  const allowPrivate = wisp.options.allow_private_ips;
  wisp.options.allow_private_ips = true;
  await new Promise(resolve => model.listen(0, address, resolve));
  const models = { providers: { 'wasmer-test': {
      baseUrl: `http://${address}:${model.address().port}/v1`,
      api: 'openai-completions',
      models: [{ id: 'test', name: 'Wasmer test', reasoning: false, input: ['text'],
        contextWindow: 32000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } };
  return {
    models,
    auth: { 'wasmer-test': { type: 'api_key', key: 'test-only-not-a-secret' } },
    healthUrl: `http://${address}:${model.address().port}/health`,
    assertComplete() {
      assert.deepEqual(errors, []);
      assert.equal(requests, steps.length + 1, 'Agent did not finish all tool turns');
    },
    async close() {
      wisp.options.allow_private_ips = allowPrivate;
      model.closeAllConnections();
      await new Promise(resolve => model.close(resolve));
    },
  };
}

export async function checkPiAgent({ page, command, waitForPrompt }) {
  const model = await startPiModelFixture();
  try {
    await command('test ! -f install.sh && test ! -f start-pi.sh && test ! -d .local/share/pnpm && test -f /opt/pi/dist/bundle/cli.js');
    assert((await command('pi --version')).includes('0.87.1'));
    await command('fd --version && rg --version');
    const lockTest = await readFile(new URL('./pi-locks.cjs', import.meta.url), 'utf8');
    await command(`printf '%s' ${quote(lockTest)} > pi-locks-test.cjs`);
    assert((await command('node pi-locks-test.cjs /opt/pi')).includes('PI_LOCKS_OK'));
    await command(`mkdir -p .pi-test && printf '%s' ${quote(JSON.stringify(model.models))} > .pi-test/models.json`);
    await command(`printf '%s' ${quote(JSON.stringify(model.auth))} > .pi-test/auth.json`);
    const preflight = `const r = require('node:module').createRequire('/opt/pi/package.json'); r('undici').fetch('${model.healthUrl}').then(r => r.text()).then(console.log).catch(e => { console.error(e, e.cause); process.exitCode = 1; });`;
    await command(`node -e ${quote(preflight)}`);
    await preparePiPreview(page);
    const setupStart = await page.evaluate(() => window.__wasmerShell.snapshot().length);
    const send = input => page.evaluate(input => window.__wasmerShell.send(input), input);
    const waitForText = text => page.waitForFunction(({ after, text }) => window.__wasmerShell.snapshot()
      .slice(after).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes(text),
    { after: setupStart, text }, { timeout: 120_000 });
    await send('PI_CODING_AGENT_DIR=/workspace/.pi-test pi --offline --provider wasmer-test --model test --thinking off --tools read,write,edit,bash,grep,find,ls --extension /workspace/pi-terminal-probe.mjs\r');
    await waitForText('pi v0.87.1');
    await send('Exercise the workspace tools.\r');
    await waitForText('PI_AGENT_TOOLS_OK');
    model.assertComplete();
    await checkPiPreview(page);
    await send('/quit\r');
    await waitForPrompt(setupStart);
    await command('test "$(cat pi-test/result.txt)" = after');
    await command("rg --hidden --glob '*.jsonl' PI_AGENT_TOOLS_OK .pi-test/sessions");

    const before = await page.evaluate(() => window.__wasmerShell.snapshot().length);
    await send('pi\r');
    await page.waitForFunction(before => window.__wasmerShell.snapshot().slice(before)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('pi v0.87.1'), before, { timeout: 60_000 });
    assert.equal(await page.locator('#preview-panel').isVisible(), false);
    await send('/login\r');
    await page.waitForFunction(before => window.__wasmerShell.snapshot().slice(before)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('Select authentication method:'), before, { timeout: 30_000 });
    await send('\x03');
    await page.waitForFunction(() => {
      const { terminal } = window.__piTest;
      const buffer = terminal.buffer.active;
      return !Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
        .some(line => line.includes('Select authentication method:'));
    });
    if (process.env.WASMER_PI_SCREENSHOT) await page.screenshot({ path: process.env.WASMER_PI_SCREENSHOT });
    await page.evaluate(() => window.__wasmerShell.send('/quit\r'));
    await waitForPrompt(before);
    await command('test ! -d .local/share/pnpm && test -d .pi/agent');
    await command('echo PI_SHELL_RECOVERED');
    console.log('PASS Pi WebC: direct pi launch, native login, streaming agent loop, read/write/edit/bash/grep/find/ls, preview, resize and exit');
  } finally {
    await model.close();
  }
}
