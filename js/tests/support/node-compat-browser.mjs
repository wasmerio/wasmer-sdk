// Also runnable in an actual Safari window through serve-node-compat.mjs.
export async function checkNodeCompatibility({ httpOrigin, wispUrl, edgePackage }) {
  const results = [];
  const record = (message) => {
    results.push(message);
    console.log(message);
    document.querySelector('pre').textContent = results.join('\n');
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const capture = Error.captureStackTrace;
  const symbols = [Symbol.dispose, Symbol.asyncDispose];
  let nativeStackHook = false;
  if (capture) {
    const descriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const marker = {};
    try {
      Error.prepareStackTrace = () => marker;
      const target = {};
      capture(target);
      nativeStackHook = target.stack === marker;
    } finally {
      if (descriptor) Object.defineProperty(Error, 'prepareStackTrace', descriptor);
      else delete Error.prepareStackTrace;
    }
  }
  const { Wasmer, Sandbox, BrowserServer } = await import('/dist/index.js');
  for (const [i, key] of ['dispose', 'asyncDispose'].entries()) {
    assert(typeof Symbol[key] === 'symbol', `Missing Symbol.${key}`);
    if (symbols[i]) assert(Symbol[key] === symbols[i], `Replaced native Symbol.${key}`);
  }
  if (nativeStackHook) assert(Error.captureStackTrace === capture, 'Replaced native stack capture');
  for (const ctor of [Wasmer, Sandbox, BrowserServer]) {
    assert(typeof ctor.prototype[Symbol.asyncDispose] === 'function', 'SDK evaluated before symbol initialization');
    assert(!Object.hasOwn(ctor.prototype, 'undefined'), 'SDK disposal method has an undefined key');
  }
  record('PASS SDK initialization and native API preservation');

  const client = new Wasmer({ cache: false, parallelism: 2 });
  let sandbox;
  try {
    const source = edgePackage.startsWith('/')
      ? new Uint8Array(await (await fetch(edgePackage)).arrayBuffer()) : edgePackage;
    const pkg = await client.packages.load(source);
    record('Loaded ' + pkg.id);
    sandbox = await client.sandboxes.create({
      packages: [pkg], network: { mode: 'wisp', url: wispUrl },
      files: { 'package.json': JSON.stringify({ private: true, dependencies: { express: '5.1.0' } }) },
      env: { HOME: '/workspace' },
    });
    const run = async (code, stdin) => {
      const output = await sandbox.command('node', ['-e', code]).run({ stdin, timeoutMs: 30_000, check: false });
      assert(output.ok, `Node failed (${output.exitCode}): ${output.stderr.text()}`);
      return output.stdout.text();
    };
    assert((await run(`
      const assert = require('node:assert/strict');
      assert.equal(typeof Symbol.dispose, 'symbol');
      assert.equal(typeof Symbol.asyncDispose, 'symbol');
      require('node:http');
      const marker = {};
      Error.prepareStackTrace = () => marker;
      const target = {};
      Error.captureStackTrace(target);
      assert.equal(target.stack, marker);
      console.log('worker-ok');
    `)).includes('worker-ok'), 'Worker compatibility failed');
    record('PASS worker HTTP module, disposal symbols, and structured stack hook');
    assert((await run(`
      const assert = require('node:assert/strict');
      const vm = require('node:vm');
      const context = vm.createContext({ answer:42 });
      const global = vm.runInContext('this', context);
      assert.equal(vm.runInContext('this === globalThis', context), true);
      assert.equal(typeof global.RegExp, 'function');
      assert.equal(new global.RegExp('released', 'g')[Symbol.replace]('released', 'closed'), 'closed');
      assert.equal(vm.runInContext('this.answer += 1', context), 43);
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      stream.getReader().releaseLock();
      assert.equal(stream.locked, false);
      console.log('vm-streams-ok');
    `)).includes('vm-streams-ok'), 'VM globals and stream reader cleanup failed');
    record('PASS VM global builtins and stream reader cleanup');
    assert((await run(`
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => { console.log('readline:' + line); rl.close(); });
    `, 'hello\n')).includes('readline:hello'), 'Readline input failed');
    record('PASS readline input');

    await sandbox.fs.writeText('hashbang.mjs', '#!/usr/bin/env node\nimport { basename } from "node:path";\nawait Promise.resolve();\nconsole.log(basename("/workspace/esm-hashbang-ok"));\n');
    const hashbang = await sandbox.command('node', ['/workspace/hashbang.mjs']).run({ timeoutMs: 30_000, check: false });
    assert(hashbang.ok && hashbang.stdout.text().includes('esm-hashbang-ok'),
      `ESM CLI hashbang failed: ${hashbang.stderr.text()}`);
    record('PASS ESM CLI hashbang with imports and top-level await');

    // Match upstream CLI bootstraps that enter through ESM and synchronously
    // require another ESM bundle. No application-specific preload is involved.
    await sandbox.fs.writeText('sync-leaf.mjs', 'globalThis.syncModuleRuns = (globalThis.syncModuleRuns || 0) + 1; export const answer = 42; export default "module-ok";');
    await sandbox.fs.writeText('sync-bundle.mjs', 'export { answer, default } from "./sync-leaf.mjs";');
    await sandbox.fs.writeText('async-leaf.mjs', 'await Promise.resolve(); export const answer = 43;');
    await sandbox.fs.writeText('async-bundle.mjs', 'export { answer } from "./async-leaf.mjs";');
    await sandbox.fs.writeText('sync-launcher.mjs', `#!/usr/bin/env node
      import assert from 'node:assert/strict';
      import { createRequire, enableCompileCache } from 'node:module';
      enableCompileCache();
      const require = createRequire(import.meta.url);
      const first = require('./sync-bundle.mjs');
      assert.equal(first.answer, 42);
      assert.equal(first.default, 'module-ok');
      assert.equal(require('./sync-bundle.mjs'), first);
      assert.equal(globalThis.syncModuleRuns, 1);
      assert.throws(() => require('./async-bundle.mjs'), { code: 'ERR_REQUIRE_ASYNC_MODULE' });
      import('./sync-bundle.mjs').then(namespace => {
        assert.equal(namespace.answer, first.answer);
        assert.equal(globalThis.syncModuleRuns, 1);
        return import('./async-leaf.mjs');
      }).then(namespace => {
        assert.equal(namespace.answer, 43);
        console.log('upstream-cli-ok');
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const launcher = await sandbox.command('node', ['/workspace/sync-launcher.mjs']).run({ timeoutMs: 30_000, check: false });
    assert(launcher.ok && launcher.stdout.text().includes('upstream-cli-ok'),
      `Synchronous ESM CLI bootstrap failed: ${launcher.stderr.text()}`);
    record('PASS upstream ESM CLI bootstrap, synchronous graph cache, and async-module rejection');

    await sandbox.fs.writeText('cycle-a.mjs', 'import "./cycle-b.mjs"; export const value = 1;');
    await sandbox.fs.writeText('cycle-b.mjs', 'import { createRequire } from "node:module"; createRequire(import.meta.url)("./cycle-a.mjs");');
    await sandbox.fs.writeText('cycle-check.mjs', `
      import assert from 'node:assert/strict';
      await assert.rejects(import('./cycle-a.mjs'), { code: 'ERR_REQUIRE_CYCLE_MODULE' });
      console.log('require-cycle-rejected');
    `);
    const cycle = await sandbox.command('node', ['/workspace/cycle-check.mjs']).run({ timeoutMs: 30_000, check: false });
    assert(cycle.ok && cycle.stdout.text().includes('require-cycle-rejected'),
      `Actual require(ESM) cycle check failed: ${cycle.stderr.text()}`);
    record('PASS actual require(ESM) cycle rejection');

    await run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      fs.mkdirSync('timestamps');
      fs.writeFileSync('timestamps/file', 'data');
      fs.utimesSync('timestamps', 1000.125, 2000.25);
      assert.equal(fs.statSync('timestamps').atimeMs, 1000125);
      assert.equal(fs.statSync('timestamps').mtimeMs, 2000250);
      const fd = fs.openSync('timestamps/file', 'r+');
      fs.futimesSync(fd, 3000.5, 4000.75);
      fs.closeSync(fd);
      assert.equal(fs.statSync('timestamps/file').mtimeMs, 4000750);
      assert.throws(() => fs.utimesSync('missing-path', 1, 2), { code: 'ENOENT' });
    `);
    await run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.equal(fs.statSync('timestamps').mtimeMs, 2000250);
      assert.equal(fs.statSync('timestamps/file').mtimeMs, 4000750);
    `);
    record('PASS native file/directory timestamps across processes');

    assert((await run(`
      fetch('https://registry.npmjs.org/express/5.1.0')
        .then(response => response.json())
        .then(pkg => { if (pkg.version !== '5.1.0') throw new Error('Unexpected registry response'); console.log('fetch-egress-ok'); })
        .catch(error => { console.error(error, error.cause); process.exitCode = 1; });
    `)).includes('fetch-egress-ok'), 'Fetch through WISP failed');
    record('PASS Node fetch through WISP');

    record('Installing Express with pnpm');
    const install = await sandbox.command('pnpm', ['install', '--reporter=append-only']).run({ timeoutMs: 120_000, check: false });
    assert(install.ok, `Express install failed: ${install.stdout.text()}\n${install.stderr.text()}`);
    // depd relies on prepareStackTrace returning CallSites, including filenames.
    await run(`require('depd')('compatibility-test')('structured stack test'); console.log('depd-ok');`);
    record('PASS Express install and depd structured-stack consumer');

    for (const framework of ['node', 'express']) {
      for (let round = 0; round < 2; round++) {
        const token = `${framework}:${round}`;
        record(`Starting ${token}`);
        const html = `<script>fetch('/health').then(r=>r.json()).then(result=>parent.postMessage(result,'*'))</script>`;
        const body = framework === 'node'
          ? `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/health'?'application/json':'text/html');res.end(req.url==='/health'?JSON.stringify({token:${JSON.stringify(token)}}):${JSON.stringify(html)});})`
          : `(()=>{const app=require('express')();app.get('/health',(_req,res)=>res.json({token:${JSON.stringify(token)}}));app.get('/',(_req,res)=>res.type('html').send(${JSON.stringify(html)}));return app;})()`;
        await sandbox.fs.writeText('server.js', `${body}.listen(8000,'0.0.0.0',()=>console.log('LISTENING'));`);
        record(`Spawning ${token}`);
        const process = await sandbox.command('node', ['/workspace/server.js']).spawn({ stdout: 'pipe', stderr: 'capture' });
        record(`Waiting for ${token} to listen`);
        let server, iframe;
        try {
          const ready = (async () => { for await (const line of process.stdout.lines()) if (line.includes('LISTENING')) return; throw new Error('No listening message'); })();
          await Promise.race([ready, process.wait().then(out => { throw new Error(`Server exited: ${out.stderr.text()}`); })]);
          server = await sandbox.ports.expose(8000, { serviceWorker: httpOrigin, timeoutMs: 15_000 });
          iframe = server.createIframe();
          await new Promise((resolve, reject) => {
            const finish = (error) => {
              clearTimeout(timer);
              window.removeEventListener('message', receive);
              error ? reject(error) : resolve();
            };
            const receive = event => {
              if (event.origin === new URL(httpOrigin).origin && event.source === iframe.contentWindow && event.data?.token === token) finish();
            };
            const timer = setTimeout(() => finish(new Error(`HTTP response missing: ${token}`)), 15_000);
            window.addEventListener('message', receive);
            document.body.append(iframe);
          });
          record(`PASS ${token} HTTP page and /health request`);
        } finally {
          iframe?.remove();
          await server?.close();
          if (round === 0) await process.terminate({ gracePeriodMs: 250 });
          else await process.kill();
          await process.wait();
        }
        record(`PASS ${token} cancellation`);
      }
    }
  } finally {
    await sandbox?.close();
    await client.close();
  }
  record('PASS all Node compatibility checks');
  return results;
}
