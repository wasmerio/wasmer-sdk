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
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => { console.log('readline:' + line); rl.close(); });
    `, 'hello\n')).includes('readline:hello'), 'Readline input failed');
    record('PASS readline input');

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
