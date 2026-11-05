import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { startAppServer } from "./support/browser-servers.mjs";

// SDK transport acceptance, using the existing browser test server and the
// runtime facade's source-WAT fixture style. These are not public API parity tests.
const engines = { chromium, firefox };
const selected = (process.env.WASMER_TEST_BROWSERS ?? "chromium,firefox").split(",");

for (const name of selected) {
  test(`${name}: v2 raw core drains bounded streams and reports the guest PID`, { timeout: 180_000 }, async context => {
    const server = await startAppServer();
    const browser = await engines[name].launch({ headless: true });
    context.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url);
    const hello = await readFile(new URL("../../swift/Tests/WasmerSDKTests/Fixtures/hello.wasm", import.meta.url));
    const result = await page.evaluate(async ({ hello }) => {
      const { RawBrowserCore } = await import("/dist/v2/raw-core.js");
      const core = await RawBrowserCore.open({ baseUrl: new URL("/pkg-v2/", location.href), machineLimit: 2 });
      const wat = source => new TextEncoder().encode(source);
      const read = async stream => new Uint8Array(await new Response(stream).arrayBuffer());
      try {
        // Reuse the SDK's existing raw-WASI fixture, including a large custom
        // section to exercise chunked bytes without a new public size limit.
        const sectionSize = 9 * 1024 * 1024;
        const header = [0];
        for (let size = sectionSize; ; size >>>= 7) {
          header.push((size & 127) | (size > 127 ? 128 : 0));
          if (size <= 127) break;
        }
        const raw = new Uint8Array(hello.length + header.length + sectionSize);
        raw.set(hello); raw.set(header, hello.length);
        const plainWasi = await core.spawn(raw);
        const [plainOut, , plainCode] = await Promise.all([read(plainWasi.stdout), read(plainWasi.stderr), plainWasi.wait()]);
        const program = wat(`(module
          (import "wasixv2" "read" (func $read (param i32 i32 i32) (result i32)))
          (import "wasixv2" "write" (func $write (param i32 i32 i32) (result i32)))
          (import "wasixv2" "exit_group" (func $exit (param i32)))
          (memory (export "memory") 1)
          (func $all (param $fd i32) (param $n i32) (local $p i32) (local $w i32)
            (loop $more
              (local.set $w (call $write (local.get $fd) (local.get $p) (local.get $n)))
              (if (i32.le_s (local.get $w) (i32.const 0)) (then (call $exit (i32.const 90))))
              (local.set $p (i32.add (local.get $p) (local.get $w)))
              (local.set $n (i32.sub (local.get $n) (local.get $w)))
              (br_if $more (local.get $n))))
          (func (export "_start") (local $n i32)
            (block $done (loop $next
              (local.set $n (call $read (i32.const 0) (i32.const 0) (i32.const 32768)))
              (br_if $done (i32.eqz (local.get $n)))
              (call $all (i32.const 1) (local.get $n))
              (call $all (i32.const 2) (local.get $n)) (br $next)))
            (call $exit (i32.const 0)) unreachable))`);
        const process = await core.spawn(program);
        const stdout = read(process.stdout), stderr = read(process.stderr);
        const waits = [process.wait(), process.wait()];
        const input = new Uint8Array(256 * 1024).map((_, index) => index % 251);
        const writer = process.stdin.getWriter();
        await writer.write(input);
        await writer.close();
        const [out, err, codes] = await Promise.all([stdout, stderr, Promise.all(waits)]);
        if (out.length !== input.length || err.length !== input.length ||
            out.some((byte, index) => byte !== input[index]) || err.some((byte, index) => byte !== input[index])) {
          throw new Error("bounded stream content mismatch");
        }
        const pid = await core.spawn(wat(`(module
          (import "wasixv2" "getpid" (func $pid (result i32)))
          (import "wasixv2" "write" (func $write (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "_start")
            (i32.store (i32.const 0) (call $pid))
            (drop (call $write (i32.const 1) (i32.const 0) (i32.const 4)))))`));
        const [pidBytes, , pidCode] = await Promise.all([read(pid.stdout), read(pid.stderr), pid.wait()]);
        const unknown = "x".repeat(96 * 1024);
        const badConfig = await core.runtime.upload(wat(JSON.stringify({ [unknown]: true })));
        const invalidReservation = await core.runtime.reserveMachine();
        let diagnostic;
        try {
          await core.runtime.request("spawn", invalidReservation, { config: badConfig });
          throw new Error("invalid configuration unexpectedly launched");
        } catch (error) { diagnostic = error.message; }
        finally {
          await core.runtime.request("abandon_machine", invalidReservation);
          await core.runtime.request("buffer_drop", badConfig);
        }
        if (!diagnostic.includes(unknown)) throw new Error("large diagnostic was truncated");
        return { codes, pidCode, pid: pid.id, reportedPid: new DataView(pidBytes.buffer).getUint32(0, true),
          outputBytes: out.length, plainCode, plainText: new TextDecoder().decode(plainOut) };
      } finally { await core.close(); }
    }, { hello: [...hello] });
    assert.deepEqual(result.codes, [0, 0]);
    assert.equal(result.pidCode, 0);
    assert.equal(result.pid, result.reportedPid);
    assert.equal(result.outputBytes, 256 * 1024);
    assert.equal(result.plainCode, 0);
    assert.equal(result.plainText, "Hello from Swift!\n");
    assert.deepEqual(errors, []);
  });

  test(`${name}: v2 close survives saturated controls, pending launches and guest traps`, { timeout: 180_000 }, async context => {
    const server = await startAppServer();
    const browser = await engines[name].launch({ headless: true });
    context.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage();
    await page.goto(server.url);
    const result = await page.evaluate(async () => {
      const { RawBrowserCore } = await import("/dist/v2/raw-core.js");
      const options = { baseUrl: new URL("/pkg-v2/", location.href), machineLimit: 2 };
      const wat = source => new TextEncoder().encode(source);
      const read = async stream => new Response(stream).arrayBuffer();
      const busy = wat(`(module (memory (export "memory") 1)
        (func (export "_start") (loop $busy (br $busy))))`);
      const core = await RawBrowserCore.open(options);
      const a = await core.spawn(busy), b = await core.spawn(busy);
      // Fill ordinary control admission synchronously, before acknowledgements.
      const controls = Array.from({ length: 32 }, () => a.resize(80, 24));
      const kills = [a.kill(), b.kill()];
      const closing = core.close();
      const settled = await Promise.allSettled([...controls, ...kills, closing]);
      if (settled.at(-1).status !== "fulfilled") throw settled.at(-1).reason;

      const trapCore = await RawBrowserCore.open(options);
      const trap = await trapCore.spawn(wat(`(module (memory (export "memory") 1)
        (func (export "_start") unreachable))`));
      await Promise.allSettled([read(trap.stdout), read(trap.stderr), trap.wait()]);
      await trapCore.close();

      // Accepted work racing close cannot publish a later running process.
      const launchCore = await RawBrowserCore.open(options);
      const module = await launchCore.runtime.upload(busy);
      const config = await launchCore.runtime.upload(wat(JSON.stringify({
        buffer: module, args: ["busy"], env: [], cwd: null, mounts: [], terminal: [80, 24],
      })));
      const reservation = await launchCore.runtime.reserveMachine();
      const launch = launchCore.runtime.request("spawn", reservation, { config });
      const launchClosing = launchCore.close();
      const launchResults = await Promise.allSettled([launch, launchClosing]);
      if (launchResults[1].status !== "fulfilled") throw launchResults[1].reason;
      return { closed: true, killStatuses: settled.slice(32, 34).map(value => value.status),
        launchSettled: launchResults.map(value => value.status), trapClosed: true };
    });
    assert.equal(result.closed, true);
    assert.equal(result.trapClosed, true);
    assert.deepEqual(result.killStatuses, ["fulfilled", "fulfilled"]);
    assert.equal(result.launchSettled[1], "fulfilled");
  });

  test(`${name}: v2 close cancels unread streams and settles admitted waits`, { timeout: 180_000 }, async context => {
    const server = await startAppServer();
    const browser = await engines[name].launch({ headless: true });
    context.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage();
    await page.goto(server.url);
    const result = await page.evaluate(async () => {
      const { RawBrowserCore } = await import("/dist/v2/raw-core.js");
      const core = await RawBrowserCore.open({ baseUrl: new URL("/pkg-v2/", location.href), machineLimit: 2 });
      const wat = source => new TextEncoder().encode(source);
      const read = async stream => new Response(stream).arrayBuffer();
      try {
        const completed = await core.spawn(wat(`(module
          (import "wasixv2" "exit_group" (func $exit (param i32)))
          (memory (export "memory") 1)
          (func (export "_start") (call $exit (i32.const 7)) unreachable))`));
        const [, , originalCode] = await Promise.all([read(completed.stdout), read(completed.stderr), completed.wait()]);
        const process = await core.spawn(wat(`(module
          (import "wasixv2" "write" (func $write (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "_start") (loop $more
            (drop (call $write (i32.const 1) (i32.const 0) (i32.const 32768)))
            (drop (call $write (i32.const 2) (i32.const 0) (i32.const 32768)))
            (br $more))))`));
        const first = process.wait(), second = process.wait();
        let settled = false;
        const outcome = first.then(
          code => ({ status: "fulfilled", code }),
          error => ({ status: "rejected", error }),
        ).then(value => { settled = true; return value; });
        // Root entries are serialized: this response fences acceptance of the
        // preceding wait without acquiring either output's HWM-zero reader.
        const fence = (await core.runtime.request("buffer_new")).value;
        await core.runtime.request("buffer_drop", fence);
        if (settled || process.stdout.locked || process.stderr.locked) {
          throw new Error("wait must be pending with both outputs unread");
        }
        await core.close();
        const result = await outcome;
        if (result.status !== "rejected" || result.error.name !== "AbortError") {
          throw new Error("close must cancel unread output rather than fabricate successful drain");
        }
        const repeated = await process.wait().catch(error => error);
        return { sameWait: first === second, repeatedReason: repeated === result.error,
          reason: result.error.name, originalCode, completedAfterClose: await completed.wait() };
      } finally { await core.close(); }
    });
    assert.deepEqual(result, { sameWait: true, repeatedReason: true, reason: "AbortError",
      originalCode: 7, completedAfterClose: 7 });
  });
}
