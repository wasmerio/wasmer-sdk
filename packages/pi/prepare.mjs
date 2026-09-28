// Preserve the conservative layout validated by the size study, without
// embedding runtime/tool modules or modifying upstream JavaScript.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const require = createRequire(new URL('./optimizer/package.json', import.meta.url));
const { optimizeDeps } = require('optimize-deps/src/optimizer');
const cwd = path.join(root, 'runtime');
const pkg = 'node_modules/@earendil-works/pi-coding-agent';
const source = path.join(cwd, pkg);
const build = path.join(root, '.build');
const traced = path.join(build, 'traced');
const runtime = path.join(build, 'runtime');
const licenses = path.join(build, 'licenses');
for (const directory of [traced, runtime, licenses]) {
  await rm(directory, { recursive: true, force: true });
}
await mkdir(licenses, { recursive: true });
const result = await optimizeDeps({
  cwd, output: traced,
  inputs: [
    `${pkg}/dist`, // Includes bundle, SDK, provider, OAuth and worker entries.
    ...['pi-ai', 'pi-agent-core', 'pi-tui', 'chord'].map(name =>
      `${pkg}/node_modules/@earendil-works/${name}/dist`),
    `${pkg}/node_modules/jiti/dist/babel.cjs`,
  ],
});
await cp(path.join(traced, '@earendil-works/pi-coding-agent'), runtime, { recursive: true });

async function* files(directory, base = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file, base);
    else if (entry.isFile()) yield path.relative(base, file);
  }
}
const externals = ['@earendil-works/chord', '@silvia-odwyer/photon-node', 'jiti', 'esbuild'];
function preserve(file) {
  if (file.endsWith('.map') || /\.d\.(ts|mts|cts)$/.test(file) || file.endsWith('.tsbuildinfo')) return false;
  if (file.startsWith('node_modules/')) {
    return externals.some(name => file.startsWith(`node_modules/${name}/`));
  }
  return file.startsWith('dist/bundle/') || file.startsWith('docs/') || file.startsWith('examples/')
    || file.startsWith('dist/modes/interactive/theme/') || file.startsWith('dist/modes/interactive/assets/')
    || ['package.json', 'README.md', 'CHANGELOG.md', 'containerization.md'].includes(file)
    || (file.startsWith('dist/core/export-html/')
      && (/\.(html|css)$/.test(file) || file.includes('/vendor/') || file.endsWith('/template.js')));
}
async function copy(file, destination) {
  const target = path.join(destination, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(source, file), target);
}
// Tracing cannot see every dynamic filesystem lookup. Preserve the complete
// upstream bundle, its externals, assets, docs, examples and license notices.
for await (const file of files(source)) {
  if (preserve(file)) await copy(file, runtime);
  if (/^(license|licence|copying|notice|copyright)/i.test(path.basename(file))) {
    await copy(file, path.join(licenses, 'npm'));
  }
}
await cp(path.join(root, 'LICENSE.pi'), path.join(licenses, 'pi-LICENSE'));

const inventory = {};
for await (const file of files(runtime)) {
  const data = await readFile(path.join(runtime, file));
  assert(data.equals(await readFile(path.join(source, file))), `Upstream file changed: ${file}`);
  inventory[file] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
const summary = {
  pi: JSON.parse(await readFile(path.join(source, 'package.json'))).version,
  optimizer: require('optimize-deps/package.json').version,
  nft: require('@vercel/nft/package.json').version,
  runtime_files: Object.keys(inventory).length,
  runtime_bytes: Object.values(inventory).reduce((total, file) => total + file.bytes, 0),
  unchanged_source_files: true,
  warnings: [...result.trace.warnings].map(String),
};
await writeFile(path.join(build, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
await writeFile(path.join(build, 'build.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Prepared Pi ${summary.pi}: ${summary.runtime_files} unchanged files, ${summary.runtime_bytes} bytes`);
