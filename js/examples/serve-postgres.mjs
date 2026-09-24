import { startAppServer } from '../tests/support/browser-servers.mjs';
const host = await startAppServer();
console.log(new URL('/examples/postgres-browser.html', host.url).href);
process.on('SIGINT', async () => { await host.close(); process.exit(0); });
