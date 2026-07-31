import { spawn } from "node:child_process";

const tests = [
  {
    name: "validation",
    file: "tests/validation.test.mjs",
    testTimeoutMs: undefined,
    processTimeoutMs: 30_000,
    attempts: 1,
  },
  {
    name: "node-network",
    file: "tests/node-network.test.mjs",
    testTimeoutMs: 30_000,
    processTimeoutMs: 60_000,
    attempts: 1,
  },
  {
    name: "runtime",
    file: "tests/runtime.test.mjs",
    testTimeoutMs: 120_000,
    processTimeoutMs: 90_000,
    attempts: 3,
  },
  {
    name: "multi-worker",
    file: "tests/multi-worker.test.mjs",
    testTimeoutMs: 30_000,
    processTimeoutMs: 60_000,
    attempts: 1,
  },
];

const requested = new Set(process.argv.slice(2));
const selected =
  requested.size === 0
    ? tests
    : tests.filter(({ name }) => requested.has(name));

if (selected.length !== (requested.size || tests.length)) {
  const known = new Set(tests.map(({ name }) => name));
  const unknown = [...requested].filter((name) => !known.has(name));
  throw new Error(`unknown Node test group: ${unknown.join(", ")}`);
}

for (const test of selected) {
  let passed = false;
  for (let attempt = 1; attempt <= test.attempts; attempt += 1) {
    const result = await runTest(test);
    if (result.code === 0) {
      passed = true;
      break;
    }
    if (attempt === test.attempts) {
      process.exitCode = result.code ?? 1;
      break;
    }
    console.error(
      `${test.name} attempt ${attempt}/${test.attempts} failed; retrying`,
    );
  }
  if (!passed) break;
}

function runTest(test) {
  const args = ["--test"];
  if (test.testTimeoutMs !== undefined) {
    args.push(`--test-timeout=${test.testTimeoutMs}`);
  }
  args.push(test.file);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
    });
    let timedOut = false;
    let forceKill;
    const deadline = setTimeout(() => {
      timedOut = true;
      console.error(
        `${test.name} exceeded ${test.processTimeoutMs}ms; terminating it`,
      );
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, test.processTimeoutMs);

    child.once("error", (error) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      resolve({
        code: timedOut ? 124 : code,
        signal,
      });
    });
  });
}
