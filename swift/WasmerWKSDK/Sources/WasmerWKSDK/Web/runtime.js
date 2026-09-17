import "./node-compat.js";
import { installHostFileSystemWorkerBridge } from "./sdk/dist/host-filesystem.js";
import { createRuntimeMemory } from "./memory-budget.js";
import { probeJSPI } from "./jspi.js";
import { installDiagnostics } from "./diagnostics.js";
import { NativeNetworkBridge, installNativeNetworkGlobals, receiveNativeNetworkReply } from "./native-network.js";

installHostFileSystemWorkerBridge();
installDiagnostics();
// Registry metadata still uses browser HTTPS. Package bytes go through native
// URLSession and its verified cache, without cross-origin download headers.
const browserFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input), import.meta.url);
  const match = /^https:\/\/cdn\.wasmer\.io\/webcimages\/([a-f0-9]{64}\.webc)$/.exec(url.href);
  if (match) return browserFetch(new URL(`./__packages/${match[1]}`, import.meta.url));
  return browserFetch(input, options);
};
const progress = (message) => postMessage({ kind: "progress", message });
let core;
let sandbox;
let runtimeMemory;
let networkBridge;
let running = false;
let terminal;
let terminalClosing = false;
let portWatcher;
let previousPorts = "";
const controls = new Set();
const outputAcks = new Map();
let nextOutputID = 0;

function streamOutput(bytes, stream) {
  return new Promise((resolve, reject) => {
    const sequence = ++nextOutputID;
    const timer = setTimeout(() => {
      outputAcks.delete(sequence);
      reject(new Error("Native terminal output timed out"));
    }, 30_000);
    outputAcks.set(sequence, { resolve, reject, timer });
    postMessage({ kind: "terminalOutput", sequence, stream, bytes }, [bytes.buffer]);
  });
}

function base64(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16 * 1024));
  }
  return btoa(text);
}

function watchPorts() {
  previousPorts = "";
  portWatcher = setInterval(() => {
    if (!sandbox || terminalClosing) return;
    const ports = sandbox.httpListeningPorts();
    if (ports == null) return; // The shared networking lock is temporarily busy.
    const key = Array.from(ports).join(",");
    if (key === previousPorts) return;
    previousPorts = key;
    postMessage({ kind: "listeningPorts", ports: Array.from(ports) });
  }, 250);
}

async function disposeSandbox() {
  clearInterval(portWatcher);
  portWatcher = undefined;
  if (sandbox) { await sandbox.close(); sandbox.free(); sandbox = undefined; }
  if (core) { await core.shutdown(); core.free(); core = undefined; }
  networkBridge?.close(); networkBridge = undefined;
}

async function watchTerminal(process) {
  let result;
  const pump = async (read, stream) => {
    for (;;) {
      const bytes = await read(16 * 1024);
      if (bytes === null) return;
      await streamOutput(bytes, stream);
    }
  };
  const pumps = [
    pump((length) => process.readStdout(length), "stdout"),
    pump((length) => process.readStderr(length), "stderr"),
  ];
  const streams = Promise.all(pumps);
  // A failed output consumer must unblock wait() and the other stream too.
  void streams.catch(() => process.kill());
  try {
    const output = await process.wait();
    result = { exitCode: output.exitCode, reason: output.reason, stdout: "", stderr: "" };
    output.free();
    await streams;
  } catch (error) {
    result = { exitCode: 1, reason: "failed", stdout: "", stderr: String(error) };
  } finally {
    terminalClosing = true;
    await Promise.allSettled([...controls, ...pumps]);
    process.free();
    terminal = undefined;
    try { await disposeSandbox(); }
    catch (error) { result = { exitCode: 1, reason: "failed", stdout: "", stderr: String(error) }; }
    terminalClosing = false;
    postMessage({ kind: "terminalExit", result });
  }
}

// Register onmessage synchronously: a replacement worker can receive a command
// before the asynchronous capability probe completes.
const capabilities = probeJSPI();
void capabilities.then((jspi) => postMessage({
  kind: "ready", workerIsolated: crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer === "function", ...jspi,
}));

onmessage = async ({ data }) => {
  if (receiveNativeNetworkReply(data)) return;
  if (data.method === "terminalOutputAck") {
    const ack = outputAcks.get(data.sequence);
    if (ack) {
      clearTimeout(ack.timer);
      outputAcks.delete(data.sequence);
      if (data.error) ack.reject(new Error(data.error)); else ack.resolve();
    }
    return;
  }
  if (["writeTerminal", "resizeTerminal", "stopTerminal", "httpRequest"].includes(data.method)) {
    const operation = (async () => {
      try {
        if (!terminal || terminalClosing) throw new Error("Terminal is not running");
        if (data.method === "httpRequest") {
          const request = data.request;
          const response = await sandbox.handleHttpRequest(data.port, request.method, request.path,
            request.headers, Uint8Array.from(atob(request.body), (char) => char.charCodeAt(0)));
          try {
            const body = response.body;
            if (body.length > 4 * 1024 * 1024) throw new Error("Preview response exceeds 4 MiB");
            postMessage({ id: data.id, keepAlive: true, result: {
              status: response.status, headers: response.headers, body: base64(body),
            } });
          } finally { response.free(); }
          return;
        }
        if (data.method === "writeTerminal") {
          await terminal.writeStdin(Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0)));
        } else if (data.method === "resizeTerminal") {
          terminal.resizeTerminal(data.columns, data.rows);
        } else terminal.kill();
        postMessage({ id: data.id, result: true, keepAlive: true });
      } catch (error) { postMessage({ id: data.id, error: String(error), keepAlive: true }); }
    })();
    controls.add(operation);
    void operation.finally(() => controls.delete(operation));
    return;
  }
  if (running || terminal) {
    postMessage({ id: data.id, error: "The prototype accepts one command at a time", keepAlive: true });
    return;
  }
  running = true;
  let shellPackage;
  try {
    if (data.method === "close") {
      await sandbox?.close();
      await core?.shutdown();
      sandbox = core = undefined;
      postMessage({ id: data.id, result: true });
      return;
    }
    const interactive = data.method === "startTerminal";
    const python = data.method === "runPython";
    if (!python && !interactive && data.method !== "runCowsay") throw new Error("Unknown prototype command");
    if (python || interactive) {
      const support = await capabilities;
      if (!support.jspi) throw new Error(support.jspiError);
    }
    if (python) {
      if (typeof data.source !== "string" || !Array.isArray(data.arguments) ||
          !data.arguments.every((argument) => typeof argument === "string")) {
        throw new Error("Python requires source text and an array of string arguments");
      }
    }
    if (!core) {
      if (!crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
        throw new Error("WebKit workers require cross-origin isolation and SharedArrayBuffer");
      }
      progress("initializing SDK");
      const sdk = await import("./sdk/pkg/wasmer_sdk_js.js");
      runtimeMemory = createRuntimeMemory();
      await sdk.default({ memory: runtimeMemory });
      sdk.setSDKUrl(new URL("./sdk/pkg/wasmer_sdk_js.js", import.meta.url).href);
      sdk.setWorkerUrl(new URL("./guest-worker.js", import.meta.url).href);
      core = sdk.WasmerCore.create({ parallelism: 1, cache: { mode: "memory" }, outputBytes: 1024 * 1024 });
    }
    if (!sandbox) {
      const builder = core.sandbox();
      const packages = interactive ? ["python/python@=3.13.20", "syrusakbary/cowsay@=0.3.0", "wasmer/edgejs@=0.2.0"] : python ? ["python/python@=3.13.20"] :
        ["syrusakbary/cowsay@=0.3.0", "wasmer/bash@=1.0.25"];
      for (const name of packages) {
        progress(`loading ${name}`);
        const loaded = await core.loadPackage(name);
        builder.package(loaded);
        if (interactive && name.startsWith("python/")) shellPackage = loaded;
        else loaded.free();
      }
      if (interactive) {
        networkBridge = new NativeNetworkBridge();
        installNativeNetworkGlobals(networkBridge);
        // This ABI composes HTTP ingress with any host DNS/TCP bridge.
        builder.networkWisp(networkBridge);
      }
      builder.mountHost("/native", 1, false);
      builder.mountHost("/readonly", 2, true);
      sandbox = await builder.start();
    }
    if (interactive) {
      // Python and Edge.js both export Bash; select one package explicitly.
      const command = sandbox.commandRef(shellPackage, "bash");
      shellPackage.free();
      shellPackage = undefined;
      // Give the shell one ordered terminal output channel. Separate stdout and
      // stderr readers can reorder readline redraws relative to program output.
      command.args(["--noprofile", "--norc", "-c", "exec bash --noprofile --norc -i 2>&1"]);
      command.currentDir("/native");
      command.env("TERM", "xterm-256color");
      command.env("PS1", "\\[\\e[38;5;42m\\]wasmer\\[\\e[0m\\]:\\w $ ");
      command.terminal(data.columns, data.rows);
      terminal = await command.spawn();
      watchPorts();
      postMessage({ id: data.id, result: true, keepAlive: true });
      void watchTerminal(terminal);
      return;
    }
    progress(python ? "running Python with JSPI" : "running cowsay");
    const command = sandbox.command(python ? "python" : "bash");
    command.args(python ? ["-u", "-c", data.source, ...data.arguments] :
      ["-c", 'cowsay "$1" && cowsay < /native/input.txt > /native/output.txt', "wasmer-cowsay-probe", data.message]);
    command.timeoutMs(120_000);
    const output = await command.run();
    const result = {
      exitCode: output.exitCode,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      reason: output.reason,
    };
    output.free();
    await disposeSandbox();
    progress(`SDK memory capacity: ${runtimeMemory.buffer.byteLength / (1024 * 1024)} MiB`);
    postMessage({ id: data.id, result });
  } catch (error) {
    postMessage({ id: data.id, error: `${error?.message ?? String(error)}\n${error?.stack ?? ""}` });
  } finally {
    shellPackage?.free();
    running = false;
  }
};
