const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const requirePi = createRequire(path.join(process.argv[2], 'package.json'));
const lockfile = requirePi('proper-lockfile');

if (process.argv[3] === 'contend') {
  assert.throws(() => lockfile.lockSync(process.argv[4], { realpath: false, stale: 2000 }), { code: 'ELOCKED' });
  console.log('CONTENDER_BLOCKED');
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync('/workspace/.pi-lock-test-');
  const file = path.join(root, 'auth.json');
  const directory = `${file}.lock`;
  fs.writeFileSync(file, '{}');
  try {
    // Ordinary directories use the same native timestamp implementation as
    // lock directories. No preload or private heartbeat files are involved.
    fs.utimesSync(root, new Date(1000), new Date(2000));
    assert.equal(fs.statSync(root).mtimeMs, 2000);
    const releaseSync = lockfile.lockSync(file, { realpath: false });
    assert.throws(() => lockfile.lockSync(file, { realpath: false }), { code: 'ELOCKED' });
    releaseSync();
    assert.equal(fs.existsSync(directory), false);

    const release = await lockfile.lock(file, { realpath: false, stale: 2000, update: 1000 });
    try {
      const before = fs.statSync(directory).mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 3300));
      assert(fs.statSync(directory).mtimeMs > before, 'Lock heartbeat did not advance');
      // A second process must see the persisted heartbeat after the original
      // stale interval, not steal a live lock based on the directory's mtime.
      assert.deepEqual(fs.readdirSync(directory), [], 'Native locks must not need heartbeat sidecars');
      const child = spawn('node', [__filename, process.argv[2], 'contend', file]);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(status, 0, output);
      assert(output.includes('CONTENDER_BLOCKED'), output);
    } finally { await release(); }
    assert.equal(fs.existsSync(directory), false);

    // Recover a stale lock through the same protocol.
    fs.mkdirSync(directory);
    fs.utimesSync(directory, new Date(1000), new Date(1000));
    assert.equal(fs.statSync(directory).mtimeMs, 1000);
    const releaseStale = lockfile.lockSync(file, { realpath: false, stale: 2000 });
    releaseStale();
    assert.equal(fs.existsSync(directory), false);

    fs.mkdirSync(directory);
    fs.utimesSync(directory, new Date(), new Date());
    fs.writeFileSync(path.join(directory, 'unrelated'), 'keep');
    assert.throws(() => fs.rmdirSync(directory), { code: 'ENOTEMPTY' });
    assert.equal(fs.readFileSync(path.join(directory, 'unrelated'), 'utf8'), 'keep');
    console.log('PI_LOCKS_OK');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
