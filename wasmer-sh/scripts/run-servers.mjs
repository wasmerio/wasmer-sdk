import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "dev";
if (mode !== "dev" && mode !== "preview") {
  throw new Error(`unknown server mode: ${mode}`);
}

const appPort = mode === "dev" ? "5173" : "4173";
const httpPort = mode === "dev" ? "5174" : "4174";
const baseArgs = mode === "dev" ? [] : ["preview"];
const appEnvironment = {
  ...process.env,
  VITE_WASMER_SERVICE_WORKER_ORIGIN:
    process.env.VITE_WASMER_SERVICE_WORKER_ORIGIN ??
    `http://127.0.0.1:${httpPort}`,
};
const children = [
  spawn(
    "vite",
    [
      ...baseArgs,
      "--host",
      "127.0.0.1",
      "--port",
      appPort,
      "--strictPort",
    ],
    {
      stdio: "inherit",
      env: appEnvironment,
    },
  ),
  spawn(
    "vite",
    [
      ...baseArgs,
      "--config",
      "service-worker/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      httpPort,
      "--strictPort",
    ],
    { stdio: "inherit" },
  ),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    stop();
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    stop();
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
