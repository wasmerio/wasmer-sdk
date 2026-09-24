import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import { startAppServer } from "./support/browser-servers.mjs";

const browsers = { chromium, firefox, webkit };
for (const name of (process.env.WASMER_TEST_BROWSERS ?? "chromium,firefox,webkit").split(",")) {
  test(`PostgreSQL and WASIX psql use browser-local TCP in ${name}`, { timeout: 180_000 }, async () => {
    const files = {};
    if (process.env.PSQL_WEBC) files["/psql.webc"] = await readFile(process.env.PSQL_WEBC);
    if (process.env.PGLITE_WEBC) files["/pglite.webc"] = await readFile(process.env.PGLITE_WEBC);
    const host = await startAppServer({ files, html: `<!doctype html><script type="importmap">{"imports":{"@mercuryworkshop/wisp-js/client":"/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/client.mjs","/node_modules/@mercuryworkshop/wisp-js/src/compat.mjs":"/node_modules/@mercuryworkshop/wisp-js/src/compat_browser.mjs"}}</script>` });
    let browser;
    const diagnostics = [];
    try {
      browser = await browsers[name].launch({ headless: true, timeout: 20_000 });
      const page = await browser.newPage();
      page.on("console", message => { diagnostics.push(message.text()); if (process.env.WASMER_TEST_VERBOSE) console.log(name, message.text()); });
      page.on("pageerror", error => diagnostics.push(error.stack));
      page.on("websocket", socket => diagnostics.push("WEBSOCKET " + socket.url()));
      await page.goto(host.url);
      const results = await page.evaluate(async ({ localPsql, localPg }) => {
        const { Wasmer } = await import("/dist/index.js");
        const wasmer = new Wasmer();
        const stranger = new Wasmer();
        const check = (value, message) => { if (!value) throw new Error(message); };
        const results = [];
        let wispRequests = 0;
        const wisp = { mode: "wisp", requestUrl() { wispRequests++; throw new Error("localhost escaped to WISP"); } };
        try {
          const bytes = async path => new Uint8Array(await (await fetch(path)).arrayBuffer());
          const psql = await wasmer.packages.load(localPsql ? await bytes("/psql.webc") : "wasmer/psql@=18.4.0");
          const pg = await wasmer.packages.load(localPg ? await bytes("/pglite.webc") : "wasmer/pglite@=0.1.3");
          console.log("PostgreSQL packages loaded");
          const start = async (network = { mode: "http" }) => {
            const sandbox = await wasmer.sandboxes.create({ packages: [pg, psql], network });
            const process = await sandbox.command(pg).spawn({ stdout: "capture", stderr: "capture" });
            // This must not consume PGlite's single accepted connection.
            await sandbox.ports.wait(5432, { timeoutMs: 10_000 });
            console.log("PostgreSQL listening");
            return { sandbox, process };
          };
          const query = (sandbox, sql = "SELECT 42;\n", env = {}) => sandbox.command(psql, ["-X", "-At", "-f", "-"], { env }).run({
            stdin: sql, timeoutMs: 15_000, outputBytes: 10 * 1024 * 1024, check: false,
          });
          const success = output => check(output.ok && output.stdout.text().includes("42"), JSON.stringify({ code: output.exitCode, out: output.stdout.text().slice(0, 300), err: output.stderr.text() }));
          const refused = async (sandbox, env) => {
            const output = await query(sandbox, undefined, env);
            check(!output.ok && output.reason === "exited" && /could not connect|connection.*failed|refused/i.test(output.stderr.text()), `expected refusal: ${output.exitCode} ${output.stderr.text()}`);
          };

          const db = await start();
          const outsider = await stranger.sandboxes.create({ packages: [psql], network: { mode: "http" } });
          await refused(outsider);
          await outsider.close();
          const isolated = await wasmer.sandboxes.create({ packages: [psql], network: { mode: "http", peers: [] } });
          await refused(isolated);
          await isolated.close();
          console.log("check complete");
          results.push("client and sandbox isolation");

          const client = await wasmer.sandboxes.create({ packages: [psql], network: wisp });
          await refused(client, { PGPORT: "5433" });
          const sql = [
            "SELECT 42;", "SELECT 'hello 🐘';", "BEGIN;", "SELECT 1/0;", "ROLLBACK;",
            "SELECT 'recovered_after_error';", "SELECT '{\"ok\":true}'::jsonb;",
            "SELECT length('" + "u".repeat(1024 * 1024) + "');",
            "SELECT repeat('x', 8 * 1024 * 1024);",
            ...Array.from({ length: 30 }, (_, i) => `SELECT 'query_${i}';`),
          ].join("\n") + "\n";
          const output = await query(client, sql);
          success(output);
          const text = output.stdout.text();
          check(text.includes("hello 🐘") && text.includes("recovered_after_error") && text.includes("1048576") && text.includes("query_29"), "lost SQL results");
          check(!output.stdout.truncated && text.includes("x".repeat(8 * 1024 * 1024)), "large TCP transfer was truncated");
          check(/division by zero/.test(output.stderr.text()), "SQL error was lost");
          check((await db.process.wait()).ok, "server failed after psql disconnected");
          await client.close(); await db.sandbox.close();
          console.log("check complete");
          results.push("automatic sharing, local DNS, recovery, 1 MiB request, 8 MiB response, 30 queries");

          const same = await start();
          success(await query(same.sandbox, undefined, { PGHOST: "127.0.0.1" }));
          await same.sandbox.close();
          console.log("check complete");
          results.push("same-sandbox loopback");

          const restricted = await start({ mode: "http", peers: [] });
          const automatic = await wasmer.sandboxes.create({ packages: [psql], network: { mode: "http" } });
          await refused(automatic);
          await automatic.close();
          const linked = await wasmer.sandboxes.create({ packages: [psql], network: { mode: "http", peers: [restricted.sandbox] } });
          success(await query(linked));
          await restricted.sandbox.close();
          await refused(linked);
          await linked.close();
          console.log("check complete");
          results.push("explicit links and closed-peer cleanup");

          const first = await start();
          const second = await start();
          const ambiguous = await wasmer.sandboxes.create({ packages: [psql], network: { mode: "http" } });
          const ambiguousOutput = await query(ambiguous);
          check(!ambiguousOutput.ok && ambiguousOutput.reason === "exited", "ambiguous port chose an arbitrary database");
          await ambiguous.close();
          const selected = await wasmer.sandboxes.create({ packages: [psql], network: { mode: "http", peers: [first.sandbox] } });
          success(await query(selected));
          await selected.close(); await first.sandbox.close(); await second.sandbox.close();
          console.log("check complete");
          results.push("duplicate-port ambiguity and explicit selection");
          check(wispRequests === 0, "localhost requested WISP");
          return results;
        } finally {
          await stranger.close(); await wasmer.close();
        }
      }, { localPsql: !!process.env.PSQL_WEBC, localPg: !!process.env.PGLITE_WEBC });
      assert.equal(results.length, 5);
      console.log(`${name}: ${results.join("; ")}`);

      // Exercise the example's live stdin and teardown, including a restart
      // while psql is still waiting for input.
      await page.goto(new URL("/examples/postgres-browser.html", host.url).href);
      await page.getByRole("button", { name: "Start database", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Connected" }).waitFor({ timeout: 30_000 });
      const sql = page.getByLabel("SQL or psql command", { exact: true });
      const send = page.getByRole("button", { name: "Send to psql", exact: true });
      await sql.fill("SELECT 1 / 0;\nSELECT 42 AS recovered;");
      await send.click();
      await page.locator("#output").filter({ hasText: "division by zero" }).waitFor();
      await page.locator("#output").filter({ hasText: "recovered" }).waitFor();
      await page.getByRole("button", { name: "Restart database", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Connected" }).waitFor({ timeout: 30_000 });
      await sql.fill("SELECT 42 AS restarted;");
      await send.click();
      await page.locator("#output").filter({ hasText: "restarted" }).waitFor();
      await sql.fill("\\q");
      await send.click();
      await page.getByRole("status").filter({ hasText: "psql exited (0)" }).waitFor();
      assert.equal(await page.locator("#error").textContent(), "");
      assert(!diagnostics.some(line => line.startsWith("WEBSOCKET ")), diagnostics.join("\n"));
    } catch (error) {
      throw new Error(`${error.stack ?? error}\n${diagnostics.join("\n")}`);
    } finally {
      await browser?.close(); await host.close();
    }
  });
}
