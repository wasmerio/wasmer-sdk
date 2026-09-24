// Called only after release artifacts have been downloaded and verified by CI.
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateIndex } from './update-index.mjs';

const [metadataFile, infoFile] = process.argv.slice(2);
if (!metadataFile || !infoFile) throw new Error('Usage: node publish-index.mjs METADATA INFO');
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (repository !== 'wasmerio/wasmer-sdk' || !token) throw new Error('Expected the SDK repository and GH_TOKEN');
const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
const info = JSON.parse(await readFile(infoFile, 'utf8'));
const branch = 'go-module-index';
async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && options.method === undefined) return null;
  if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${path} returned ${response.status}`);
  return response.json();
}
const release = await api(`releases/tags/${metadata.tag}`);
if (!release || release.draft || release.prerelease) throw new Error('Only a complete published stable release may be indexed');
for (const name of Object.keys(metadata.files)) {
  if (!release.assets.some(asset => asset.name === name)) throw new Error(`Missing published asset ${name}`);
}
const directory = await mkdtemp(join(tmpdir(), 'wasmer-go-index-'));
try {
  const indexFile = join(directory, 'versions.json');
  let ref = await api(`git/ref/heads/${branch}`);
  const previous = ref ? await api(`contents/go/proxy/versions.json?ref=${branch}`) : null;
  if (previous) await writeFile(indexFile, Buffer.from(previous.content, 'base64'));
  await updateIndex(indexFile, metadata, info);
  const content = await readFile(indexFile);
  if (previous && content.equals(Buffer.from(previous.content, 'base64'))) {
    console.log(`Go proxy already indexes ${info.Version}`);
  } else {
    if (!ref) {
      ref = await api('git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: metadata.source_sha }) });
      // The newly created branch already contains the empty index from the release source.
    }
    const current = previous ?? await api(`contents/go/proxy/versions.json?ref=${branch}`);
    await api('contents/go/proxy/versions.json', { method: 'PUT', body: JSON.stringify({
      message: `Publish Go module index for ${info.Version}`, content: content.toString('base64'),
      branch, ...(current ? { sha: current.sha } : {}),
    }) });
    console.log(`Go proxy index updated for ${info.Version}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
