import assert from 'node:assert/strict';
import { createLocalBashOperations } from '/opt/pi/dist/bundle/index.js';

const operations = createLocalBashOperations();
const probe = await operations.exec('sleep 0.01', '/workspace', { onData() {} });
assert.equal(probe.exitCode, 0, 'The cancellation target must be executable');
const controller = new AbortController();
const start = Date.now();
let output = '';
await assert.rejects(operations.exec('printf READY; exec sleep 30', '/workspace', {
  signal: controller.signal,
  onData(chunk) {
    output += chunk;
    if (output.includes('READY')) controller.abort();
  },
}), { message: 'aborted' });
assert(output.includes('READY'));
const abortElapsed = Date.now() - start;
assert(abortElapsed < 10000, `Abort took ${abortElapsed}ms; the child must not sleep for 30s`);

const timeoutStart = Date.now();
await assert.rejects(operations.exec('exec sleep 30', '/workspace', {
  timeout: 0.2,
  onData() {},
}), { message: 'timeout:0.2' });
const timeoutElapsed = Date.now() - timeoutStart;
assert(timeoutElapsed < 10000, `Timeout took ${timeoutElapsed}ms; the child must not sleep for 30s`);
console.log('PI_SHELL_CANCELLATION_OK');
