import assert from 'node:assert/strict';
import test from 'node:test';
import { OPFSVolume, filesystemError } from '../Sources/WasmerWKSDK/Web/opfs-filesystem.js';

test('DOMException numeric codes map to filesystem error names', () => {
  assert.equal(filesystemError(new DOMException('quota', 'QuotaExceededError')).code, 'ENOSPC');
  assert.equal(filesystemError(new DOMException('missing', 'NotFoundError')).code, 'ENOENT');
});

// Faithful file-handle semantics: one exclusive sync handle per file, explicit
// offsets, closed-handle errors, and a persistent directory across volume opens.
function fixture() {
  const counts = { current: 0, peak: 0 }, locks = new Set();
  const error = name => Object.assign(new Error(name), { name });
  function directory() {
    const entries = new Map();
    return {
      async getDirectoryHandle(name, {create} = {}) {
        if (!entries.has(name) && create) entries.set(name, directory());
        if (!entries.has(name)) throw error('NotFoundError');
        return entries.get(name);
      },
      async getFileHandle(name, {create} = {}) {
        if (!entries.has(name) && create) {
          let bytes = new Uint8Array(), active = false;
          entries.set(name, {async createSyncAccessHandle() {
            if (active) throw error('NoModificationAllowedError');
            active = true; counts.current++; counts.peak = Math.max(counts.peak, counts.current);
            let closed = false;
            const check = () => { if (closed) throw error('InvalidStateError'); };
            return {
              read(out, {at}) { check(); const data = bytes.subarray(at, at + out.length); out.set(data); return data.length; },
              write(data, {at}) { check(); if (at + data.length > bytes.length) this.truncate(at + data.length); bytes.set(data, at); return data.length; },
              truncate(size) { check(); const next = new Uint8Array(size); next.set(bytes.subarray(0,size)); bytes = next; },
              getSize() { check(); return bytes.length; }, flush() { check(); },
              close() { check(); closed = true; active = false; counts.current--; },
            };
          }});
        }
        if (!entries.has(name)) throw error('NotFoundError');
        return entries.get(name);
      },
      async *keys() { yield* entries.keys(); },
      async removeEntry(name) { entries.delete(name); },
    };
  }
  const root = directory();
  return {counts, storage: { async getDirectory() { return root; } }, locks: {
    async request(name, options, callback) {
      if (locks.has(name)) return callback(null);
      locks.add(name); try { return await callback({name}); } finally { locks.delete(name); }
    },
  }};
}
const open = (v, name, options = {}) => v.request('open', [name, true, true, true, false, false, false].map((value, i) => options[i] ?? value));
const write = (v, fd, text, at = 0) => v.request('write', [fd, at, [...new TextEncoder().encode(text)]]);
const read = async (v, fd) => new TextDecoder().decode(await v.request('read', [fd, 0, 65536]));

test('OPFS persists binary contents and namespace, including directory rename', async () => {
  const f = fixture(); let v = await OPFSVolume.open('test', f.storage, f.locks);
  try {
    await v.request('mkdir', ['a']); await v.request('mkdir', ['a/b']);
    const fd = await open(v, 'a/b/file'); await write(v, fd, 'hello\0π');
    await v.request('rename', ['a', 'renamed']);
    assert.equal(await read(v, fd), 'hello\0π');
    assert.deepEqual(await v.request('readDir', ['renamed']), [{name:'b',kind:'directory',size:0}]);
    await v.close(); v = await OPFSVolume.open('test', f.storage, f.locks);
    assert.equal(await read(v, await open(v, 'renamed/b/file')), 'hello\0π');
    await assert.rejects(v.request('stat', ['a']), {code:'ENOENT'});
  } finally { await v.close(); }
  assert.equal(f.counts.current, 0);
});

test('OPFS bounds cached handles and supports multiple descriptors, append, truncation and unlink', async () => {
  const f = fixture(), v = await OPFSVolume.open('test', f.storage, f.locks);
  try {
    for (let i = 0; i < 150; i++) {
      const fd = await open(v, 'file' + i); await write(v, fd, String(i)); await v.request('close', [fd]);
    }
    assert.ok(f.counts.peak <= 66, `peak handles ${f.counts.peak}`);
    const fd = await open(v, 'file0'), append = await open(v, 'file0', {6:true});
    await write(v, append, 'last'); assert.equal(await read(v, fd), '0last');
    await v.request('remove', ['file0']); await write(v, append, '!');
    assert.equal(await read(v, fd), '0last!');
    await v.request('setLen', [fd, 2]); assert.equal(await read(v, append), '0l');
    const newFD = await open(v, 'file0'); assert.equal(await read(v, newFD), '');
    await v.request('rename', ['file1', 'file0']);
    assert.equal(await read(v, await open(v, 'file0')), '1');
    assert.equal(await read(v, newFD), '');
  } finally { await v.close(); }
});

test('OPFS rejects traversal, conflicting writers, invalid bytes and nonempty removals', async () => {
  const f = fixture(), v = await OPFSVolume.open('test', f.storage, f.locks);
  try {
    await assert.rejects(OPFSVolume.open('test', f.storage, f.locks), {code:'EBUSY'});
    await assert.rejects(v.request('stat', ['../secret']), {code:'EACCES'});
    await v.request('mkdir', ['folder']); const fd = await open(v, 'folder/file');
    await assert.rejects(v.request('write', [fd, 0, [256]]), {code:'EINVAL'});
    await assert.rejects(v.request('remove', ['folder']), {code:'ENOTEMPTY'});
    await assert.rejects(v.request('rename', ['folder', 'folder/child']), {code:'EINVAL'});
    await v.request('close', [fd]); await assert.rejects(v.request('read', [fd,0,1]), {code:'EBADF'});
  } finally { await v.close(); }
});

test('OPFS recovers an incomplete final journal record and collects orphan data', async () => {
  const f = fixture(); let v = await OPFSVolume.open('recovery', f.storage, f.locks);
  const fd = await open(v, 'kept'); await write(v, fd, 'intact');
  const removed = await open(v, 'removed'); await write(v, removed, 'garbage');
  await v.request('remove', ['removed']); await v.close();
  const root = await f.storage.getDirectory(), volumes = await root.getDirectoryHandle('wasmer-volumes');
  const dir = await volumes.getDirectoryHandle('recovery');
  // Simulate a creation that never reached the journal. Its ID must not be
  // reused while the background orphan collector is deleting old contents.
  await dir.getFileHandle('data-10000', {create:true});
  const journal = await (await dir.getFileHandle('namespace.log')).createSyncAccessHandle();
  journal.write(new TextEncoder().encode('["put","unfinished'), {at:journal.getSize()}); journal.close();
  v = await OPFSVolume.open('recovery', f.storage, f.locks);
  try {
    assert.equal(await read(v, await open(v, 'kept')), 'intact');
    assert.equal((await v.request('readDir', [''])).length, 1);
    await write(v, await open(v, 'next'), 'complete');
    const names = []; for await (const name of dir.keys()) names.push(name);
    assert.equal(names.filter(name => name.startsWith('data-')).length, 2);
    assert.ok(names.includes('data-10001'));
  } finally { await v.close(); }
  v = await OPFSVolume.open('recovery', f.storage, f.locks);
  try { assert.equal(await read(v, await open(v, 'next')), 'complete'); } finally { await v.close(); }
});
