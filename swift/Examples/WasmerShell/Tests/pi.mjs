// Run the iOS app against the same local streaming fixture as the Pi SDK tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startPiModelFixture } from '../../../../wasmer-sh/tests/support/pi-agent.mjs';

const model = await startPiModelFixture();
try {
  const child = spawn('python3', [
    fileURLToPath(new URL('../build.py', import.meta.url)),
    'test', '--example', 'pi', ...process.argv.slice(2),
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SIMCTL_CHILD_PI_TEST_MODELS: JSON.stringify(model.models),
      SIMCTL_CHILD_PI_TEST_AUTH: JSON.stringify(model.auth),
      SIMCTL_CHILD_PI_TEST_HEALTH_URL: model.healthUrl,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, 'Pi simulator test failed');
  model.assertComplete();
  console.log('PASS iOS Pi: local streaming model verified all seven tool results');
} finally {
  await model.close();
}
