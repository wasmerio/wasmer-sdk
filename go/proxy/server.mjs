import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MODULE = 'go.wasmer.io/sdk';
export const RELEASE_BASE = 'https://github.com/wasmerio/wasmer-sdk/releases/download/';
const versionPattern = /^v(0|1)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function compareVersions(a, b) {
  const left = a.slice(1).split('.').map(BigInt);
  const right = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function validateIndex(index) {
  if (index?.schema !== 1 || index.module !== MODULE || !index.versions ||
      typeof index.versions !== 'object' || Array.isArray(index.versions)) {
    throw new Error('Invalid module index');
  }
  for (const [version, entry] of Object.entries(index.versions)) {
    if (!versionPattern.test(version) || !entry ||
        typeof entry.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.time) ||
        !Number.isFinite(Date.parse(entry.time)) || !/^[a-f0-9]{40}$/.test(entry.source_sha) ||
        !entry.sha256 || Object.keys(entry.sha256).sort().join(',') !== 'info,mod,zip' ||
        !Object.values(entry.sha256).every(v => typeof v === 'string' && digestPattern.test(v))) {
      throw new Error(`Invalid release entry: ${version}`);
    }
  }
  const versions = Object.keys(index.versions).sort(compareVersions);
  if (index.latest !== (versions.at(-1) ?? null)) throw new Error('Incorrect latest version');
  return index;
}

// Only metadata is read here. Versioned asset requests redirect to GitHub's
// stable release URLs; GitHub handles the potentially large archive transfers.
export function createProxy({
  indexFile = new URL('./versions.json', import.meta.url),
  indexURL,
  indexTTL = 60_000,
  publicOrigin = 'https://go.wasmer.io',
  releaseBase = RELEASE_BASE,
  onError = console.error,
} = {}) {
  const origin = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('publicOrigin must be an HTTP(S) origin');
  }
  let cachedIndex;
  let refreshAt = 0;
  let pending;
  async function loadIndex() {
    if (!indexURL) return validateIndex(JSON.parse(await readFile(indexFile, 'utf8')));
    if (cachedIndex && Date.now() < refreshAt) return cachedIndex;
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetch(indexURL, { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error(`Index returned HTTP ${response.status}`);
          const candidate = validateIndex(await response.json());
          for (const [version, previous] of Object.entries(cachedIndex?.versions ?? {})) {
            const current = candidate.versions[version];
            if (!current || current.time !== previous.time || current.source_sha !== previous.source_sha ||
                ['info', 'mod', 'zip'].some(ext => current.sha256[ext] !== previous.sha256[ext])) {
              throw new Error(`Index attempted to remove or alter ${version}`);
            }
          }
          cachedIndex = candidate;
        } catch (error) {
          if (!cachedIndex) throw error;
          onError(error); // Previously verified immutable releases remain available.
        } finally {
          refreshAt = Date.now() + indexTTL;
          pending = undefined;
        }
        return cachedIndex;
      })();
    }
    return pending;
  }
  const send = (req, res, code, body, headers = {}) => {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    // Do not normalize dot segments or encoded separators into valid routes.
    const rawPath = req.url.split('?')[0];
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('%') || rawPath.includes('\\') ||
        rawPath.split('/').some(p => p === '.' || p === '..')) {
      send(req, res, 404, 'Not found\n');
      return;
    }
    const url = new URL(req.url, origin);
    if ((rawPath === '/sdk' || rawPath.startsWith('/sdk/')) && url.searchParams.get('go-get') === '1') {
      const escape = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
      send(req, res, 200,
        `<!doctype html><html><head><meta name="go-import" content="${MODULE} mod ${escape(origin.origin)}/mod"></head></html>\n`,
        { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return;
    }
    const prefix = `/mod/${MODULE}/`;
    if (!rawPath.startsWith(prefix) || url.search) {
      send(req, res, 404, 'Unknown module or route\n');
      return;
    }
    const route = rawPath.slice(prefix.length);
    const asset = /^@v\/(v[^/]+)\.(info|mod|zip)$/.exec(route);
    if (route !== '@v/list' && route !== '@latest' && (!asset || !versionPattern.test(asset[1]))) {
      send(req, res, 404, 'Unknown module version or route\n');
      return;
    }
    try {
      // Atomic index replacement makes each request see one complete revision.
      const index = await loadIndex();
      if (route === '@v/list') {
        const versions = Object.keys(index.versions).sort(compareVersions);
        send(req, res, 200, versions.map(v => `${v}\n`).join(''), { 'Cache-Control': 'public, max-age=60' });
      } else if (route === '@latest') {
        if (!index.latest) send(req, res, 404, 'No published versions\n');
        else send(req, res, 200,
          JSON.stringify({ Version: index.latest, Time: index.versions[index.latest].time }) + '\n',
          { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
      } else if (!Object.hasOwn(index.versions, asset[1])) {
        send(req, res, 404, 'Unknown module version\n');
      } else {
        const location = new URL(`wasmer-sdk-go-${asset[1]}/${asset[1]}.${asset[2]}`, releaseBase).href;
        send(req, res, 302, '', { Location: location, 'Cache-Control': 'public, max-age=86400, immutable' });
      }
    } catch (error) {
      onError(error);
      send(req, res, 503, 'Module index unavailable\n', { 'Retry-After': '30' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const server = createProxy({
    indexFile: process.env.MODULE_INDEX ?? new URL('./versions.json', import.meta.url),
    indexURL: process.env.MODULE_INDEX_URL,
    publicOrigin: process.env.PUBLIC_ORIGIN ?? 'https://go.wasmer.io',
  });
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log(`Go module proxy listening on ${server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
