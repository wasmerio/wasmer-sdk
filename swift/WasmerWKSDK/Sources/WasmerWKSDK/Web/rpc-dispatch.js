// The wire adapter delegates SDK semantics to the same WasmerCore used by JS.
// Handles never expose Wasm pointers or accept arbitrary method/property names.
export const encode = bytes => {
  let value = "";
  for (let i = 0; i < bytes.length; i += 16384) value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
export const decode = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const errorValue = error => ({ code: error?.code ?? "EXECUTION_ERROR", message: error?.message ?? String(error) });
const outputValue = value => {
  try { return { exitCode: value.exitCode, reason: value.reason, stdout: encode(value.stdout), stderr: encode(value.stderr),
    stdoutTruncated: value.stdoutTruncated, stderrTruncated: value.stderrTruncated }; }
  finally { value.free(); }
};

export class SDKDispatcher {
  #core; #initialize; #network; #storage; #progress; #cancellation; #ready; #next = 0;
  #packages = new Map(); #packageIDs = new Map(); #sandboxes = new Map(); #processes = new Map(); #jobs = new Map();
  constructor(initialize, network, storage, progress, cancellation) { this.#initialize = initialize; this.#network = network; this.#storage = storage; this.#progress = progress; this.#cancellation = cancellation; }
  async request(id, method, args) {
    const job = { id, cancelled: false, process: undefined, sandbox: undefined, loadCancellation: undefined };
    this.#jobs.set(id, job);
    try {
      if (method === "initialize") {
        this.#ready ??= this.#initialize(args).then(core => { this.#core = core; });
        await this.#ready;
        return true;
      }
      if (!this.#ready) fail("CLIENT_CLOSED", "Client was not initialized");
      await this.#ready;
      const result = await this.#dispatch(method, args, job);
      if (job.cancelled) fail("CANCELLED", "Swift task cancelled");
      return result;
    } finally { this.#jobs.delete(id); this.#collect(); }
  }
  #collect() {
    const jobs = [...this.#jobs.values()];
    for (const [id, value] of this.#processes) {
      if (value.released && !jobs.some(job => job.process === value.process)) {
        value.process.free(); this.#processes.delete(id);
      }
    }
    for (const [id, value] of this.#sandboxes) {
      if (value.closed && value.value && !jobs.some(job => job.sandbox === value.handle)) {
        value.value.free(); this.#sandboxes.delete(id);
      }
    }
  }
  cancel(id) {
    const job = this.#jobs.get(id);
    if (job) { job.cancelled = true; job.process?.kill(); job.loadCancellation?.cancel(); }
  }
  #package(handle) {
    const value = this.#packages.get(handle);
    if (!value) fail("INVALID_ARGUMENT", "Package belongs to a different or closed client");
    return value;
  }
  #retainPackage(value) {
    const existing = this.#packageIDs.get(value.id);
    if (existing) { value.free(); return existing; }
    const handle = ++this.#next; this.#packages.set(handle, value);
    const metadata = { handle, id: value.id, commands: value.commands, entrypoint: value.entrypoint ?? null };
    this.#packageIDs.set(value.id, metadata);
    return metadata;
  }
  #sandbox(handle, job) {
    const value = this.#sandboxes.get(handle);
    if (!value || value.closed) fail("SANDBOX_CLOSED", "Sandbox is closed");
    job.sandbox = handle;
    return value;
  }
  #process(handle, job) {
    const value = this.#processes.get(handle);
    if (!value) fail("PROCESS_TERMINATED", "Process is no longer available");
    job.process = value.process; job.sandbox = value.sandbox;
    return value;
  }
  #command(args, job) {
    const sandbox = this.#sandbox(args.sandbox, job).value;
    const selection = args.selector;
    const command = selection.kind === "name" ? sandbox.command(selection.name) :
      selection.kind === "package" ? sandbox.commandPackage(this.#package(selection.package)) :
      selection.kind === "reference" ? sandbox.commandRef(this.#package(selection.package), selection.name) :
      fail("INVALID_ARGUMENT", "Invalid command selector");
    try {
      command.args(args.args ?? []);
      if (args.cwd != null) command.currentDir(args.cwd);
      for (const [key, value] of Object.entries(args.env ?? {})) command.env(key, value);
      if (args.timeoutMs != null) command.timeoutMs(args.timeoutMs);
      if (args.outputBytes != null) command.outputBytes(args.outputBytes);
      return command;
    } catch (error) { command.free(); throw error; }
  }
  async #dispatch(method, args, job) {
    switch (method) {
      case "package.many": {
        const cancellation = this.#cancellation();
        job.loadCancellation = cancellation;
        if (job.cancelled) cancellation.cancel();
        const reused = args.sources.filter(s => s.package != null).map(s => this.#package(s.package));
        const sources = args.sources.filter(s => s.package == null).map(s => s.registry ?? decode(s.bytes));
        const onProgress = args.progress ? progress => {
          const ids = new Set(progress.packages.map(p => p.id));
          const packages = [...progress.packages];
          for (const pkg of reused) {
            if (ids.has(pkg.id)) continue;
            ids.add(pkg.id);
            packages.push({ id: pkg.id, phase: "ready", cached: true,
              download: { downloadedBytes: 0, totalBytes: 0, percent: 100 } });
          }
          if (!job.cancelled) this.#progress({ kind: "packageProgress", id: job.id, progress: { ...progress, packages } });
        } : undefined;
        try {
          const loaded = await this.#core.loadPackages(sources, onProgress, cancellation);
          if (job.cancelled) { for (const pkg of loaded) pkg.free(); fail("CANCELLED", "Swift task cancelled"); }
          let next = 0;
          return args.sources.map(s => s.package != null ? this.#packageIDs.get(this.#package(s.package).id) : this.#retainPackage(loaded[next++]));
        } finally { job.loadCancellation = undefined; cancellation.free(); }
      }
      case "package.load": return this.#retainPackage(await this.#core.loadPackage(args.source));
      case "package.bytes": return this.#retainPackage(await this.#core.loadPackageBytes(decode(args.bytes)));
      case "package.create": {
        const definition = { ...args, modules: Object.fromEntries(Object.entries(args.modules).map(([k,v]) => [k, decode(v)])),
          files: Object.fromEntries(Object.entries(args.files).map(([k,v]) => [k, decode(v)])) };
        if (definition.entrypoint == null) delete definition.entrypoint;
        return this.#retainPackage(await this.#core.createPackage(definition));
      }
      case "sandbox.create": {
        const builder = this.#core.sandbox();
        let network, storageMount;
        try {
          for (const handle of args.packages) builder.package(this.#package(handle));
          for (const [path, bytes] of Object.entries(args.files)) builder.file(path, decode(bytes));
          for (const [key, value] of Object.entries(args.env)) builder.env(key, value);
          for (const mount of args.mounts ?? []) {
            if (mount.path === "/workspace" && args.storage?.kind === "native") builder.storageHost(mount.id);
            else builder.mountHost(mount.path, mount.id, mount.readOnly);
          }
          // Memory uses the core's shared in-memory filesystem, just like the
          // browser SDK. Guest file operations stay inside Wasm instead of
          // making a synchronous worker round trip for every read and stat.
          if (args.storage?.kind === "opfs") {
            if (!this.#storage) fail("CAPABILITY_UNAVAILABLE", "Worker storage is unavailable");
            storageMount = await this.#storage.open(args.storage.volume);
            builder.storageHost(storageMount);
          }
          if (args.network === "host") { network = this.#network(); builder.networkWisp(network); }
          else builder.network(args.network);
          const value = await builder.start();
          if (job.cancelled) {
            await value.close(); value.free(); network?.close();
            fail("CANCELLED", "Swift task cancelled");
          }
          const handle = ++this.#next;
          this.#sandboxes.set(handle, { handle, value, network, storageMount, closed: false });
          return handle;
        } catch (error) { network?.close(); if (storageMount) await this.#storage.close(storageMount); throw error; }
        finally { if (builder.__wbg_ptr) builder.free(); }
      }
      case "sandbox.install": {
        const sandbox = this.#sandbox(args.sandbox, job).value;
        return this.#retainPackage(await sandbox.installPackageRef(this.#package(args.package)));
      }
      case "sandbox.close": {
        const sandbox = this.#sandboxes.get(args.sandbox);
        if (!sandbox || sandbox.closed) return true;
        sandbox.closed = true; job.sandbox = args.sandbox;
        for (const value of this.#processes.values()) if (value.sandbox === args.sandbox) value.process.kill();
        await sandbox.value.close();
        sandbox.network?.close();
        if (sandbox.storageMount) await this.#storage.close(sandbox.storageMount);
        // Free only after outstanding async SDK borrows have unwound.
        return true;
      }
      case "command.run":
      case "command.spawn": {
        const command = this.#command(args, job);
        const capture = method === "command.run";
        const input = capture && args.input ? decode(args.input) : undefined;
        try {
          command.stdinMode(capture ? input?.length ? "pipe" : "closed" : args.stdin);
          command.stdoutMode(capture ? "capture" : args.stdout);
          command.stderrMode(capture ? "capture" : args.stderr);
          if (args.terminal) command.terminal(args.terminal.columns, args.terminal.rows);
          const process = await command.spawn();
          job.process = process;
          if (job.cancelled) process.kill();
          if (capture) {
            const feed = (async () => {
              if (!input?.length) return;
              try {
                for (let i = 0; i < input.length; i += 65536) await process.writeStdin(input.subarray(i, i + 65536));
                await process.closeStdin();
              } catch (error) {
                // Like Rust Command::output, a guest may exit before consuming stdin.
                if (!/broken pipe|stdin is closed/i.test(String(error))) throw error;
              }
            })();
            let output;
            const waiting = process.wait().then(value => { output = value; return value; });
            try {
              const [value] = await Promise.all([waiting, feed]);
              return outputValue(value);
            } finally {
              process.kill(); await Promise.allSettled([feed, waiting]);
              if (output?.__wbg_ptr) output.free();
              process.free();
            }
          }
          if (job.cancelled) {
            process.free();
            fail("CANCELLED", "Swift task cancelled");
          }
          const handle = ++this.#next;
          this.#processes.set(handle, { process, sandbox: args.sandbox });
          return { handle, id: process.id };
        } finally { if (command.__wbg_ptr) command.free(); }
      }
      case "process.release": {
        const value = this.#processes.get(args.process);
        if (value) { value.released = true; value.process.kill(); }
        return true;
      }
      case "process.read": {
        const value = this.#process(args.process, job).process;
        const bytes = await (args.stderr ? value.readStderr(args.maxBytes) : value.readStdout(args.maxBytes));
        return bytes === null ? null : encode(bytes);
      }
      case "process.write": await this.#process(args.process, job).process.writeStdin(decode(args.bytes)); return true;
      case "process.closeStdin": await this.#process(args.process, job).process.closeStdin(); return true;
      case "process.wait": return outputValue(await this.#process(args.process, job).process.wait());
      case "process.kill": this.#process(args.process, job).process.kill(); return true;
      case "process.terminate": await this.#process(args.process, job).process.terminate(args.graceMs); return true;
      case "process.resize": this.#process(args.process, job).process.resizeTerminal(args.columns, args.rows); return true;
      case "fs.write": await this.#sandbox(args.sandbox, job).value.writeFile(args.path, decode(args.bytes)); return true;
      case "fs.read": return encode(await this.#sandbox(args.sandbox, job).value.readFile(args.path));
      case "fs.mkdir": this.#sandbox(args.sandbox, job).value.mkdir(args.path, args.recursive); return true;
      case "fs.readDir": return this.#sandbox(args.sandbox, job).value.readDir(args.path);
      case "fs.stat": return this.#sandbox(args.sandbox, job).value.stat(args.path);
      case "fs.remove": this.#sandbox(args.sandbox, job).value.remove(args.path, args.recursive); return true;
      case "fs.rename": await this.#sandbox(args.sandbox, job).value.rename(args.from, args.to); return true;
      case "ports.wait": {
        if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) fail("INVALID_ARGUMENT", "Invalid guest port");
        const sandbox = this.#sandbox(args.sandbox, job);
        if (!sandbox.network) fail("CAPABILITY_UNAVAILABLE", "Port probing requires sandbox networking");
        // Browser ingress lives in WASIX memory. Probing native localhost would
        // connect to the host instead of observing this sandbox's listener.
        const deadline = performance.now() + args.timeoutMs;
        while (performance.now() < deadline) {
          if (job.cancelled) fail("CANCELLED", "Swift task cancelled");
          if (this.#sandbox(args.sandbox, job).value.isHttpPortListening(args.port)) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        fail("TIMEOUT", `Timed out waiting for guest port ${args.port}`);
      }
      case "ports.list": {
        const ports = this.#sandbox(args.sandbox, job).value.httpListeningPorts();
        return ports == null ? null : Array.from(ports);
      }
      case "ports.request": {
        const response = await this.#sandbox(args.sandbox, job).value.handleHttpRequest(args.port, args.method, args.path, args.headers, decode(args.body));
        try { return { status: response.status, headers: response.headers, body: encode(response.body) }; }
        finally { response.free(); }
      }
      default: fail("INVALID_ARGUMENT", `Unknown SDK operation: ${method}`);
    }
  }
}
