import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MODULE, validateIndex, compareVersions } from './server.mjs';

// The caller supplies metadata downloaded and verified from a published release.
// Serialize index updates in the release workflow to avoid lost updates.
export async function updateIndex(indexFile, metadata, info) {
  if (metadata.component !== 'go' || metadata.repository !== 'wasmerio/wasmer-sdk' ||
      metadata.tag !== `wasmer-sdk-go-v${metadata.version}` || info.Version !== `v${metadata.version}`) {
    throw new Error('Unexpected Go release identity');
  }
  let index;
  try {
    index = validateIndex(JSON.parse(await readFile(indexFile, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    index = { schema: 1, module: MODULE, latest: null, versions: {} };
  }
  const entry = {
    time: info.Time,
    source_sha: metadata.source_sha,
    sha256: Object.fromEntries(['info', 'mod', 'zip'].map(ext => [ext, metadata.files?.[`${info.Version}.${ext}`]])),
  };
  const previous = index.versions[info.Version];
  if (previous && (previous.time !== entry.time || previous.source_sha !== entry.source_sha ||
      ['info', 'mod', 'zip'].some(ext => previous.sha256[ext] !== entry.sha256[ext]))) {
    throw new Error(`Refusing to change published version ${info.Version}`);
  }
  index.versions[info.Version] = entry;
  index.latest = Object.keys(index.versions).sort(compareVersions).at(-1);
  validateIndex(index);
  const temporary = `${indexFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, indexFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [indexFile, metadataFile, infoFile] = process.argv.slice(2);
  if (!indexFile || !metadataFile || !infoFile) throw new Error('Usage: node update-index.mjs INDEX METADATA INFO');
  await updateIndex(indexFile, JSON.parse(await readFile(metadataFile, 'utf8')), JSON.parse(await readFile(infoFile, 'utf8')));
}
