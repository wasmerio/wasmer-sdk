import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { startAppServer, startHttpHost } from './browser-servers.mjs';

export async function startNodeCompatibilityServer() {
  const proxy = http.createServer();
  proxy.on('upgrade', (request, socket, head) => wisp.routeRequest(request, socket, head));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const host = await startHttpHost();
  const localPackage = process.env.WASMER_EDGEJS_WEBC;
  const config = {
    httpOrigin: host.url,
    wispUrl: `ws://127.0.0.1:${proxy.address().port}/`,
    edgePackage: localPackage ? '/edge.webc' : 'wasmer/edge@=0.2.1',
  };
  const app = await startAppServer({
    files: localPackage ? { '/edge.webc': await readFile(localPackage) } : {},
    html: `<!doctype html><meta charset="utf-8"><title>Node compatibility test</title><pre>Starting…</pre>
<script type="importmap">{"imports":{
  "@mercuryworkshop/wisp-js/client":"/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/client.mjs",
  "/node_modules/@mercuryworkshop/wisp-js/src/compat.mjs":"/node_modules/@mercuryworkshop/wisp-js/src/compat_browser.mjs"
}}</script>
<script type="module">
import { checkNodeCompatibility } from '/tests/support/node-compat-browser.mjs';
let timer;
window.result = Promise.race([
  checkNodeCompatibility(${JSON.stringify(config)}),
  new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Node compatibility checks timed out')), 210_000); }),
]).finally(() => clearTimeout(timer));
window.result.catch(error => { document.querySelector('pre').textContent += '\\nFAIL: ' + error.message + '\\n' + error.stack; });
</script>`,
  });
  return {
    url: app.url,
    async close() {
      await app.close();
      await host.close();
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startNodeCompatibilityServer();
  console.log(`Open in Safari 27+: ${server.url}`);
}
