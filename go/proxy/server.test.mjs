import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy, MODULE, RELEASE_BASE, validateIndex } from './server.mjs';
import { updateIndex } from './update-index.mjs';

const entry = {
  time: '2026-09-22T00:00:00Z', source_sha: 'a'.repeat(40),
  sha256: { info: 'b'.repeat(64), mod: 'c'.repeat(64), zip: 'd'.repeat(64) },
};
const initial = () => ({ schema: 1, module: MODULE, latest: 'v0.10.0', versions: { 'v0.10.0': entry, 'v0.9.0': entry } });

async function fixture(t, data = initial(), options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wasmer-go-proxy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const indexFile = join(directory, 'versions.json');
  await writeFile(indexFile, JSON.stringify(data));
  const server = createProxy({ indexFile, onError() {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { indexFile, request: (path, options) => fetch(base + path, { redirect: 'manual', ...options }) };
}

test('discovery resolves root module from nested package paths', async t => {
  const { request } = await fixture(t);
  for (const path of ['/sdk', '/sdk/cmd/wasmer-sdk']) {
    const response = await request(`${path}?go-get=1`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /content="go.wasmer.io\/sdk mod https:\/\/go.wasmer.io\/mod"/);
  }
  assert.equal((await request('/sdk-other?go-get=1')).status, 404);
});

test('versions are ordered numerically and latest has canonical metadata', async t => {
  const { request } = await fixture(t);
  assert.equal(await (await request(`/mod/${MODULE}/@v/list`)).text(), 'v0.9.0\nv0.10.0\n');
  assert.deepEqual(await (await request(`/mod/${MODULE}/@latest`)).json(), { Version: 'v0.10.0', Time: entry.time });
});

test('asset requests redirect to stable public release URLs', async t => {
  const { request } = await fixture(t);
  for (const ext of ['info', 'mod', 'zip']) {
    const response = await request(`/mod/${MODULE}/@v/v0.10.0.${ext}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${RELEASE_BASE}wasmer-sdk-go-v0.10.0/v0.10.0.${ext}`);
    assert.match(response.headers.get('cache-control'), /immutable/);
  }
  const head = await request(`/mod/${MODULE}/@v/v0.10.0.zip`, { method: 'HEAD' });
  assert.equal(head.status, 302);
  assert.equal(await head.text(), '');
});

test('unpublished, unsupported, encoded and foreign requests never redirect', async t => {
  const { request } = await fixture(t);
  for (const route of ['v0.1.0.zip', 'v2.0.0.zip', 'v0.01.0.zip', 'main.zip', 'v0.10.0.exe',
    'v0.10.0.zip?token=x', 'v0.10.0%2f.zip', 'v0.10.0.zip/other']) {
    const response = await request(`/mod/${MODULE}/@v/${route}`);
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get('location'), null);
  }
  assert.equal((await request('/mod/example.org/sdk/@v/list')).status, 404);
  const post = await request(`/mod/${MODULE}/@v/list`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('empty index differs from missing or corrupt index', async t => {
  const { request, indexFile } = await fixture(t, { schema: 1, module: MODULE, latest: null, versions: {} });
  assert.equal((await request(`/mod/${MODULE}/@v/list`)).status, 200);
  assert.equal((await request(`/mod/${MODULE}/@latest`)).status, 404);
  await writeFile(indexFile, '{');
  assert.equal((await request(`/mod/${MODULE}/@v/list`)).status, 503);
  await rm(indexFile);
  assert.equal((await request(`/mod/${MODULE}/@v/v0.10.0.zip`)).status, 503);
});

test('index activation is additive, idempotent and preserves immutable versions', async t => {
  const { indexFile, request } = await fixture(t);
  const metadata = version => ({ component: 'go', repository: 'wasmerio/wasmer-sdk',
    version, tag: `wasmer-sdk-go-v${version}`, source_sha: entry.source_sha,
    files: Object.fromEntries(Object.entries(entry.sha256).map(([ext, hash]) => [`v${version}.${ext}`, hash])),
  });
  const info = { Version: 'v0.11.0', Time: entry.time };
  await updateIndex(indexFile, metadata('0.11.0'), info);
  const bytes = await readFile(indexFile, 'utf8');
  await updateIndex(indexFile, metadata('0.11.0'), info);
  assert.equal(await readFile(indexFile, 'utf8'), bytes);
  assert.equal((await (await request(`/mod/${MODULE}/@latest`)).json()).Version, 'v0.11.0');
  await updateIndex(indexFile, metadata('0.8.0'), { ...info, Version: 'v0.8.0' });
  assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).latest, 'v0.11.0');
  const changed = metadata('0.11.0');
  changed.files['v0.11.0.zip'] = 'e'.repeat(64);
  await assert.rejects(updateIndex(indexFile, changed, info), /Refusing to change/);
  const invalid = initial();
  invalid.latest = 'v0.9.0';
  assert.throws(() => validateIndex(invalid), /latest/);
});

test('remote refresh preserves known releases during outages and rejects mutation', async t => {
  let status = 503;
  let data = initial();
  const upstream = createServer((req, res) => { res.writeHead(status); res.end(JSON.stringify(data)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { request } = await fixture(t, initial(), { indexURL: `http://127.0.0.1:${upstream.address().port}/index`, indexTTL: 0 });
  const route = `/mod/${MODULE}/@v/list`;
  assert.equal((await request(route)).status, 503);
  status = 200;
  const expected = await (await request(route)).text();
  assert.equal(expected, 'v0.9.0\nv0.10.0\n');
  status = 503;
  assert.equal(await (await request(route)).text(), expected);
  status = 200;
  data = { ...initial(), versions: { 'v0.10.0': entry } };
  assert.equal(await (await request(route)).text(), expected);
  data = { ...initial(), latest: 'v0.11.0', versions: { ...initial().versions, 'v0.11.0': entry } };
  assert.equal(await (await request(route)).text(), 'v0.9.0\nv0.10.0\nv0.11.0\n');
});
