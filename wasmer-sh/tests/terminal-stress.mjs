import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const rounds = Number(process.env.WASMER_STRESS_ROUNDS ?? 3);
assert(Number.isInteger(rounds) && rounds > 0, "WASMER_STRESS_ROUNDS must be a positive integer");
const artifact = process.env.WASMER_STRESS_REPORT ?? join(tmpdir(), "wasmer-browser-stress-result.json");
const proxy = http.createServer();
proxy.on("upgrade", (request, socket, head) => wisp.routeRequest(request, socket, head));
let server, browser, page;
const diagnostics = [];
const runtimeErrors = [];
let monitor;
let last = "";
const checks = [];
async function workerStacks() {
  const cdp = await browser.newBrowserCDPSession();
  const messages = [];
  cdp.on("Target.receivedMessageFromTarget", event => {
    const message = JSON.parse(event.message);
    if (message.method === "Debugger.paused") messages.push({ target: event.targetId, frames: message.params.callFrames.map(frame => ({ functionName: frame.functionName, url: frame.url, location: frame.location })) });
  });
  const { targetInfos } = await cdp.send("Target.getTargets");
  const sessions = [];
  for (const target of targetInfos.filter(target => target.type === "worker")) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    sessions.push(sessionId);
    await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 1, method: "Debugger.enable" }) });
    await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 2, method: "Debugger.pause" }) });
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const sessionId of sessions) await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 3, method: "Debugger.resume" }) });
  await cdp.detach();
  return { targetInfos, messages };
}
const deadline = async (promise, ms, name) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const send = text => deadline(page.evaluate(text => globalThis.__wasmerShell.send(text), text), 15_000, "terminal input");
const waitFor = (text, timeout = 30_000) => deadline(page.waitForFunction(text => globalThis.__wasmerShell.snapshot().replace(/\x1b\[[0-9;]*m/g, "").includes(text), text, { timeout }), timeout + 1000, text);
let sequence = 0;
async function command(name, command, { timeout = 30_000, keyboard = false, expected, during } = {}) {
  const id = ++sequence;
  const marker = `__STRESS_${id}_DONE__`;
  console.log(`START ${name}`);
  const start = Date.now();
  // Split the marker so an echoed command cannot satisfy the output assertion.
  const input = `${command}; printf '\\n__STRESS_%s_DONE__:%s\\n' ${id} "$?"`;
  if (keyboard) {
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(input);
    await page.keyboard.press("Enter");
  } else {
    await send(input + "\r");
  }
  await during?.();
  await waitFor(`${marker}:`, Number(process.env.WASMER_STRESS_TIMEOUT ?? timeout));
  const text = await page.evaluate(() => globalThis.__wasmerShell.snapshot());
  assert(text.includes(`${marker}:0`), `${name} failed: ${text.slice(-4000)}`);
  if (expected) assert(text.includes(expected), `${name} lost terminal output: ${expected}`);
  checks.push({ name, milliseconds: Date.now() - start, sdkHeapBytes: await page.evaluate(() => globalThis.__stressSDKMemory.buffer.byteLength) });
  console.log(`PASS ${name} (${Date.now() - start}ms)`);
}
// Exercise cancellation with real listening sockets, not only sleeping processes.
// epoll must release its registration guards when a server exits without DEL.
async function serverCycle(name, input, ready, verify) {
  const id = ++sequence;
  const before = await page.evaluate(() => globalThis.__wasmerShell.snapshot().length);
  const start = Date.now();
  await send(`${input}; printf '\\n__SERVER_%s_EXIT__:%s\\n' ${id} "$?"\r`);
  await page.waitForFunction(({ before, ready }) => globalThis.__wasmerShell.snapshot().slice(before).includes(ready), { before, ready }, { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('#preview-panel').hidden);
  if (verify) {
    let verified = false;
    const end = Date.now() + 30_000;
    while (Date.now() < end && !verified) {
      for (const frame of page.frames()) {
        verified = await frame.evaluate(() => document.querySelectorAll('#checks li').length === 3 && [...document.querySelectorAll('#checks li')].every(li => li.textContent.startsWith('PASS:'))).catch(() => false);
        if (verified) break;
      }
      if (!verified) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(verified, `${name}: preview did not pass health and validation checks`);
  }
  await send("\x03");
  await waitFor(`\n__SERVER_${id}_EXIT__:`);
  await page.waitForFunction(() => document.querySelector('#preview-panel').hidden, undefined, { timeout: 5000 });
  checks.push({ name, milliseconds: Date.now() - start, sdkHeapBytes: await page.evaluate(() => globalThis.__stressSDKMemory.buffer.byteLength) });
  console.log(`PASS ${name} (${Date.now() - start}ms)`);
}
try {
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  // Disable HMR so unrelated local edits cannot restart the stress session.
  server = await createServer({ root, configFile: `${root}/vite.config.ts`, logLevel: "warn", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.addInitScript(() => {
    // Exercise the same fixed SDK heap budget as the iOS prototype. Guest
    // memories are created in workers and are unaffected by this window hook.
    const NativeMemory = WebAssembly.Memory;
    WebAssembly.Memory = new Proxy(NativeMemory, {
      construct(target, [descriptor]) {
        if (descriptor.initial === 25 && descriptor.shared) {
          const memory = Reflect.construct(target, [{ ...descriptor, maximum: 8192 }]);
          globalThis.__stressSDKMemory = memory;
          return memory;
        }
        return Reflect.construct(target, [descriptor]);
      },
    });
    addEventListener("unhandledrejection", event => console.error("STRESS REJECTION", event.reason?.stack ?? String(event.reason)));
    addEventListener("error", event => console.error("STRESS ERROR", event.error?.stack ?? event.message));
  });
  page.on("console", message => {
    const text = message.text();
    diagnostics.push(`console.${message.type()}: ${text}`);
    if (message.type() === "error" && /Wasmer SDK worker failed|STRESS (ERROR|REJECTION)|RuntimeError|RangeError/.test(text)) runtimeErrors.push(text);
  });
  page.on("pageerror", error => { runtimeErrors.push(error.stack); diagnostics.push(`pageerror: ${error.stack}`); console.error(error.stack); });
  page.on("worker", worker => { diagnostics.push(`worker: ${worker.url()}`); worker.on("close", () => diagnostics.push(`worker closed: ${worker.url()}`)); });
  const query = new URLSearchParams({ use: "python/python@=3.13.20", wisp: `ws://127.0.0.1:${proxy.address().port}/` });
  query.append("use", "syrusakbary/cowsay@=0.3.0");
  query.append("use", "wasmer/edgejs@=0.2.0");
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`);
  await page.waitForFunction(() => document.querySelector("#session-status")?.textContent === "Ready", undefined, { timeout: 180_000 });
  await waitFor("$ ");
  monitor = setInterval(async () => {
    try {
      const text = await deadline(page.evaluate(() => globalThis.__wasmerShell.snapshot()), 3000, "UI heartbeat");
      if (text !== last) { console.log(`Terminal active (${text.length} retained characters)`); last = text; }
    } catch (error) { console.error(error.message); }
  }, 5000);
  await command("Python baseline", "python -c \"print('PYTHON_READY')\"");
  await serverCycle("basic Python server cancellation", "python python/server.py", "Python listening on http://localhost:8000", false);
  await command("install FastAPI after server cancellation", "pip install -r python-fastapi/requirements.txt", { timeout: 180_000 });
  for (let round = 0; round < 3; round++) {
    await serverCycle(`FastAPI HTTP and port cleanup ${round}`, "python python-fastapi/server.py", "Uvicorn running on", true);
    await command(`Python after FastAPI cancellation ${round}`, "python -c \"print('AFTER_CANCEL')\"");
  }
  for (let round = 0; round < rounds; round++) {
    for (const example of ["django", "fastapi"]) {
      await command(`pip ${example} requirements ${round}`, `pip install --force-reinstall --no-cache-dir --upgrade -r python-${example}/requirements.txt`, { timeout: 180_000 });
      await command(`import ${example} after pip ${round}`, `python -c 'import ${example}; print(${example}.__version__)'`, { keyboard: true });
    }
  }
  for (let round = 0; round < 30; round++) {
    await command(`keyboard and child process ${round}`, `python -c 'print("KEYBOARD_READY:%s" % ${round})'`, { keyboard: true, expected: `\nKEYBOARD_READY:${round}\n` });
  }
  await command("input during output pressure", `python -u -c "import sys,threading,time; print('OUTPUT_BUSY'); t=threading.Thread(target=lambda: [(sys.stdout.write('x'*4096+'\\n'),time.sleep(.002)) for _ in range(512)]); t.start(); s=input(); t.join(); assert s=='stress-input'"`, {
    during: async () => {
      await waitFor("\nOUTPUT_BUSY\n");
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("stress-input");
      await page.keyboard.press("Enter");
    },
  });
  await send(`python -u -c "import time; print('INTERRUPT_READY'); time.sleep(120)"\r`);
  await waitFor("\nINTERRUPT_READY\n");
  await send("\x03");
  await command("input after Ctrl-C", "python -c \"print('INTERRUPT_OK')\"", { keyboard: true });
  const heapGrowth = checks.at(-1).sdkHeapBytes - checks[0].sdkHeapBytes;
  assert(heapGrowth < 128 * 1024 * 1024, `SDK heap grew by ${heapGrowth} bytes across repeated commands`);
  assert.deepEqual(runtimeErrors, [], "browser runtime errors occurred during stress testing");
  await writeFile(artifact, JSON.stringify({ passed: true, checks }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  console.error("TRANSCRIPT", await deadline(page?.evaluate(() => globalThis.__wasmerShell?.snapshot()?.slice(-16000)), 3000, "failure transcript").catch(() => last.slice(-16000)));
  console.error(diagnostics.slice(-50).join("\n"));
  const stacks = await deadline(workerStacks(), 5000, "worker stack capture").catch(String);
  await writeFile(artifact, JSON.stringify({ passed: false, error: String(error), checks, transcript: last.slice(-16000), diagnostics, stacks }, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  await browser?.close();
  await server?.close();
  proxy.closeAllConnections();
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  console.log(`Stress report: ${artifact}`);
}
