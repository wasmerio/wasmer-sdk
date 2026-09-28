// Requires the built WebC and wasmer-sh's installed test dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPiModelFixture } from '../../wasmer-sh/tests/support/pi-agent.mjs';

const root = await mkdtemp(join(tmpdir(), 'wasmer-pi-webc-'));
const model = await startPiModelFixture();
try {
  await writeFile(join(root, 'models.json'), JSON.stringify(model.models));
  await writeFile(join(root, 'auth.json'), JSON.stringify(model.auth));
  await writeFile(join(root, 'hello.js'), await readFile(new URL('../../wasmer-sh/workspace/pi/hello.js', import.meta.url)));
  const webc = process.argv[2] ?? fileURLToPath(new URL('../../target/pi-0.87.1.webc', import.meta.url));
  const child = spawn(process.env.WASMER_BIN ?? 'wasmer', ['run', webc, '--experimental-napi', '--net',
    '--volume', `${root}:/workspace`, '--cwd', '/workspace',
    '--env', 'HOME=/workspace', '--env', 'PI_CODING_AGENT_DIR=/workspace',
    '--',
    '--offline', '--provider', 'wasmer-test', '--model', 'test', '--thinking', 'off',
    '--tools', 'read,write,edit,bash,grep,find,ls', '-p', 'Exercise the workspace tools.',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
  let status;
  try {
    status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(status, 0, output);
  model.assertComplete();
  assert(output.includes('PI_AGENT_TOOLS_OK'), output);
  assert.equal(await readFile(join(root, 'pi-test/result.txt'), 'utf8'), 'after\n');
  console.log('PASS Pi WebC: authenticated streaming, all seven tools, file edits');
} finally {
  await model.close();
  await rm(root, { recursive: true, force: true });
}
