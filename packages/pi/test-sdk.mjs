// Uses the rebuilt Wasmer SDK host, including its real filesystem/N-API fixes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startPiModelFixture } from '../../wasmer-sh/tests/support/pi-agent.mjs';

const { Wasmer } = await import(process.env.WASMER_PI_SDK
  ? pathToFileURL(process.env.WASMER_PI_SDK) : new URL('../../js/dist/node.js', import.meta.url));
const client = new Wasmer({ cache: false });
const model = await startPiModelFixture();
let sandbox;
try {
  const source = process.argv[2] ?? new URL('../../target/pi-0.87.1.webc', import.meta.url);
  const pkg = await client.packages.load(
    typeof source === 'string' && !source.endsWith('.webc')
      ? source : new Uint8Array(await readFile(source)),
  );
  sandbox = await client.sandboxes.create({
    packages: [pkg],
    env: { HOME: '/workspace', PI_CODING_AGENT_DIR: '/workspace', PATH: '/bin:/usr/bin' },
    files: {
      'models.json': JSON.stringify(model.models),
      'auth.json': JSON.stringify(model.auth),
      'hello.js': await readFile(new URL('../../wasmer-sh/workspace/pi/hello.js', import.meta.url)),
      'shell-cancellation.mjs': await readFile(new URL('./tests/shell-cancellation.mjs', import.meta.url)),
      '.npmrc': 'registry=https://alias-registry.invalid/\n',
      'search/hello world.txt': 'dependency search π\n',
      'search/.gitignore': 'ignored.txt\n',
      'search/ignored.txt': 'dependency search hidden\n',
    },
    network: { mode: 'host' },
  });
  for (const command of ['pi', 'node', 'npm', 'pnpm', 'fd', 'rg', 'grep', 'sed', 'find', 'xargs', 'locate', 'updatedb', 'curl', 'tail', 'nohup']) {
    const version = await sandbox.command(command, ['--version']).run({ timeoutMs: 30_000, check: false });
    assert(version.ok, `${command}: ${version.stderr.text()}`);
    assert.match(version.stdout.text(), /\d+\.\d+(?:\.\d+)?/);
    if (command === 'npm' || command === 'pnpm') {
      assert.equal(version.stdout.text().trim(), '10.34.5');
      const registry = await sandbox.command(command, ['config', 'get', 'registry'])
        .run({ timeoutMs: 30_000 });
      assert.equal(registry.stdout.text().trim(), 'https://alias-registry.invalid/');
    }
    if (command === 'fd') assert.match(version.stdout.text(), /fd 10\.5\.0/);
    if (command === 'rg') assert.match(version.stdout.text(), /ripgrep 15\.2\.0/);
  }
  await sandbox.fs.writeText('.npmrc', '');
  for (const command of [
    'pi --version',
    '/bin/pi --version',
    'exec pi --offline --provider openai --model gpt-5.5 --version',
  ]) {
    const version = await sandbox.command('bash', ['-c', command]).run({ timeoutMs: 30_000 });
    assert.equal(version.stdout.text().trim(), '0.87.1', command);
  }
  const found = await sandbox.command('fd', [
    '--no-require-git', '--glob', '*.txt', '/workspace/search',
  ]).run();
  assert(found.stdout.text().includes('hello world.txt'));
  assert(!found.stdout.text().includes('ignored.txt'));
  const matched = await sandbox.command('rg', [
    '--no-require-git', '--json', 'dependency search', '/workspace/search',
  ]).run();
  const matches = matched.stdout.text().trim().split('\n').map(JSON.parse).filter(x => x.type === 'match');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].data.lines.text, 'dependency search π\n');
  const shellTools = await sandbox.command('bash', ['-c', `
set -euo pipefail
find /workspace/search -name '*.txt' -print0 | xargs -0 grep -l 'dependency search π' | sed 's|/workspace/search/||'
`]).run({ timeoutMs: 30_000 });
  assert.equal(shellTools.stdout.text(), 'hello world.txt\n');
  const edit = await sandbox.command('sed', ['-i', 's/dependency search/shell edit/', '/workspace/search/hello world.txt']).run();
  assert(edit.ok);
  assert.equal(await sandbox.fs.readText('search/hello world.txt'), 'shell edit π\n');
  const health = await sandbox.command('curl', ['--fail', '--silent', '--show-error', model.healthUrl])
    .run({ timeoutMs: 15_000 });
  assert.equal(health.stdout.text(), 'ok');
  const nohup = await sandbox.command('bash', ['-c',
    `nohup node -e 'console.log("NOHUP_OK")' > nohup-test.log 2>&1 && tail -n 1 nohup-test.log`,
  ]).run({ timeoutMs: 15_000 });
  assert.equal(nohup.stdout.text(), 'NOHUP_OK\n');
  const background = await sandbox.command('bash', ['-c', `
set -e
sleep 4 & child=$!
sleep 0.05
kill -0 "$child"
kill "$child"
wait "$child" 2>/dev/null || :
printf 'NONBLOCKING_WAIT_OK\\n'
`]).run({ timeoutMs: 10_000 });
  assert.equal(background.stdout.text(), 'NONBLOCKING_WAIT_OK\n');
  const cancellation = await sandbox.command('node', ['/workspace/shell-cancellation.mjs'])
    .run({ timeoutMs: 25_000, check: false });
  assert(cancellation.ok, `${cancellation.stdout.text()}\n${cancellation.stderr.text()}`);
  assert(cancellation.stdout.text().includes('PI_SHELL_CANCELLATION_OK'));
  const output = await sandbox.command('pi', [
    '--offline', '--provider', 'wasmer-test', '--model', 'test', '--thinking', 'off',
    '--tools', 'read,write,edit,bash,grep,find,ls', '-p', 'Exercise the workspace tools.',
  ])
    .run({ timeoutMs: 120_000, check: false });
  assert(output.ok, `${output.stdout.text()}\n${output.stderr.text()}`);
  model.assertComplete();
  assert(output.stdout.text().includes('PI_AGENT_TOOLS_OK'));
  assert.equal(await sandbox.fs.readText('pi-test/result.txt'), 'after\n');
  console.log('PASS Pi WebC: registry search tools, shell pipeline, upstream CLI, streaming model fixture, all seven tools');
} finally {
  await sandbox?.close();
  await client.close();
  await model.close();
}
