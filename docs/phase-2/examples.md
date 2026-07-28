# Universal Wasmer SDK: scenario cookbook

Status: complete draft for review  
Last updated: 2026-07-27

These examples exercise the proposed Phase 2 API. They are design fixtures for
Phase 3, not code that can be run from this repository yet.

Package specifications are pinned when a currently known package is suitable.
`<tested-pin>` is intentional where Phase 3 still needs to select and verify an
exact package and invocation. We should not invent a PostgreSQL package name or
pretend every registry package supports every target.

## Cache configuration used by the examples

On Node.js and native desktop hosts, this is enough:

```ts
const wasmer = await Wasmer.create();
```

It captures the current project root and uses `.wasmer` beneath it for
content-addressed packages and target-partitioned compiled artifacts.

An explicit location is equally simple:

```ts
const wasmer = await Wasmer.create({
  projectRoot: "/absolute/path/to/project",
  cache: {
    directory: ".wasmer",
    packages: true,
    compiled: true,
    maxBytes: 4 * 1024 * 1024 * 1024,
  },
});
```

Browser examples use the same logical cache with browser storage:

```ts
const wasmer = await Wasmer.create({
  cache: {
    namespace: "sandbox-examples",
    packages: true,
    compiled: true,
  },
});
```

See the complete [cache design](cache-design.md). The remaining snippets assume
that `wasmer` has already been created.

## 1. Run Python in a short-lived sandbox

This is the shortest useful path: create a sandbox with a package, run one
command, capture output, and clean up. It uses the same object model as every
longer workflow.

### JavaScript

```ts
import { Wasmer } from "@wasmer/sdk";

const wasmer = await Wasmer.create();

await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
});

const output = await sandbox.command("python", {
  args: ["-c", "print(sum(n * n for n in range(10)))"],
}).run({
  timeoutMs: 5_000,
});

output.check();
console.log((await output.stdout.text()).trim()); // 285
```

### Rust

```rust
use std::time::Duration;
use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;

    let sandbox = wasmer
        .sandbox()
        .package("python/python@3.12")
        .start()
        .await?;

    let output = sandbox
        .command("python")
        .args(["-c", "print(sum(n * n for n in range(10)))"])
        .timeout(Duration::from_secs(5))
        .output()
        .await?
        .check()?;

    println!("{}", output.stdout.text()?.trim());
    sandbox.close().await?;
    Ok(())
}
```

There is no `runPython()` primitive. Python is a package, so this path also
works for Ruby, Bash, ffmpeg, a compiler, or an application-specific CLI.

## 2. Run JavaScript with EdgeJS QuickJS

Seeded files make short-lived sandbox execution useful without separate
filesystem setup calls.

### JavaScript host

```ts
const edgejs = await wasmer.loadPackage(
  "wasmer/edgejs-quickjs@0.0.3",
);

await using sandbox = await wasmer.createSandbox({
  packages: [edgejs],
  files: {
    "/workspace/main.js": `
      const name = process.argv[2] ?? "world";
      console.log(JSON.stringify({ greeting: \`Hello, \${name}\` }));
    `,
  },
});

const output = await sandbox.command(edgejs.entrypoint!, {
  args: ["/workspace/main.js", "Ada"],
}).run();

const value = JSON.parse(await output.check().stdout.text());
console.log(value.greeting);
```

### Rust host

```rust
let source = r#"
    const name = process.argv[2] ?? "world";
    console.log(JSON.stringify({ greeting: `Hello, ${name}` }));
"#;

let edgejs = wasmer
    .load_package("wasmer/edgejs-quickjs@0.0.3")
    .await?;
let entrypoint = edgejs.entrypoint()
    .ok_or_else(|| Error::command_not_found("package entrypoint"))?;

let sandbox = wasmer
    .sandbox()
    .package(edgejs)
    .file("/workspace/main.js", source.as_bytes())
    .start()
    .await?;

let output = sandbox
    .command(entrypoint)
    .args(["/workspace/main.js", "Ada"])
    .output()
    .await?
    .check()?;

sandbox.close().await?;
```

The exact EdgeJS command contract remains a Phase 3 compatibility test. The
important SDK property is that no JavaScript-specific branch is involved.

## 3. Keep a workspace across commands

Session use keeps files, environment, package resolution, and process state
together.

### JavaScript

```ts
await using sandbox = await wasmer.createSandbox({
  packages: [
    "python/python@3.12",
    "wasmer/bash@1.0.25",
  ],
  env: {
    APP_ENV: "test",
  },
  limits: {
    memoryBytes: 512 * 1024 * 1024,
    maxProcesses: 8,
  },
});

await sandbox.fs.writeText(
  "/workspace/build.py",
  `
from pathlib import Path
Path("/workspace/result.txt").write_text("built in " + __import__("os").environ["APP_ENV"])
`,
);

(await sandbox.command("python", {
  args: ["/workspace/build.py"],
}).run()).check();

const listing = await sandbox.shell(
  "wc -c /workspace/result.txt && cat /workspace/result.txt",
).run();

console.log(await listing.check().stdout.text());
```

### Rust

```rust
let sandbox = wasmer
    .sandbox()
    .package("python/python@3.12")
    .package("wasmer/bash@1.0.25")
    .env("APP_ENV", "test")
    .memory_limit(512 * 1024 * 1024)
    .max_processes(8)
    .start()
    .await?;

sandbox
    .fs()
    .write_text(
        "/workspace/build.py",
        r#"
from pathlib import Path
Path("/workspace/result.txt").write_text(
    "built in " + __import__("os").environ["APP_ENV"]
)
"#,
    )
    .await?;

sandbox
    .command("python")
    .arg("/workspace/build.py")
    .output()
    .await?
    .check()?;

let listing = sandbox
    .shell("wc -c /workspace/result.txt && cat /workspace/result.txt")
    .output()
    .await?
    .check()?;
```

`shell()` is concise for a trusted script. User-controlled values should be
passed through `args` to a command instead of interpolated into the script.

## 4. Treat files as inputs and artifacts

Binary files are first-class. A sandbox need not encode them through strings
or base64.

### JavaScript

```ts
const input = new Uint8Array(await fetch("/photo.png").then((r) =>
  r.arrayBuffer()
));

await using sandbox = await wasmer.createSandbox({
  packages: ["namespace/image-tools@<tested-pin>"],
  files: {
    "/workspace/input.png": input,
    "/workspace/config.json": JSON.stringify({ width: 320 }),
  },
  limits: {
    filesystemBytes: 64 * 1024 * 1024,
  },
});

(await sandbox.command("resize", {
  args: [
    "--config", "/workspace/config.json",
    "/workspace/input.png",
    "/workspace/output.webp",
  ],
}).run()).check();

const artifact = await sandbox.fs.readFile("/workspace/output.webp");
```

### Rust

```rust
let sandbox = wasmer
    .sandbox()
    .package("namespace/image-tools@<tested-pin>")
    .file("/workspace/input.png", image_bytes)
    .file("/workspace/config.json", br#"{"width":320}"#)
    .filesystem_limit(64 * 1024 * 1024)
    .start()
    .await?;

sandbox
    .command("resize")
    .args([
        "--config",
        "/workspace/config.json",
        "/workspace/input.png",
        "/workspace/output.webp",
    ])
    .output()
    .await?
    .check()?;

let artifact = sandbox
    .fs()
    .read("/workspace/output.webp")
    .await?;
```

## 5. Stream a long-running command

`spawn` is the step from a completed operation to a live process.

### JavaScript

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
  files: {
    "/workspace/progress.py": `
import time
for i in range(5):
    print(f"step={i}", flush=True)
    time.sleep(0.2)
`,
  },
});

const process = await sandbox.command("python", {
  args: ["-u", "/workspace/progress.py"],
}).spawn();

const reader = process.stdout!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value, { stream: true }));
}

const output = await process.wait();
output.check();
```

### Rust

```rust
let mut process = sandbox
    .command("python")
    .args(["-u", "/workspace/progress.py"])
    .spawn()
    .await?;

let mut stdout = process
    .take_stdout()
    .ok_or(Error::StreamUnavailable)?;

while let Some(bytes) = stdout.next_chunk().await? {
    print!("{}", String::from_utf8_lossy(&bytes));
}

process.wait().await?.check()?;
```

Streams apply backpressure. Consumers that do not read piped output still have
a configured bound; the guest cannot grow host memory without limit.

### 5.1 Write stdin and collect stdout/stderr

Use `spawn()` when input arrives over time or output must be observed before
the command exits. Start both output readers before writing input so a chatty
guest cannot block on a full pipe.

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
  files: {
    "/workspace/uppercase.py": `
import sys
for line in sys.stdin:
    print(line.rstrip().upper(), flush=True)
`,
  },
});

const process = await sandbox.command("python", {
  args: ["-u", "/workspace/uppercase.py"],
}).spawn({
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

async function collectText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

const stdoutPromise = collectText(process.stdout!);
const stderrPromise = collectText(process.stderr!);

const writer = process.stdin!.getWriter();
const encoder = new TextEncoder();
await writer.write(encoder.encode("hello\n"));
await writer.write(encoder.encode("from wasmer\n"));
await writer.close(); // Sends EOF; it does not terminate the process.

const [stdout, stderr, output] = await Promise.all([
  stdoutPromise,
  stderrPromise,
  process.wait(),
]);

output.check();
console.log(stdout); // HELLO\nFROM WASMER\n
console.error(stderr);
```

The equivalent Rust flow takes each pipe once, drains stdout and stderr
concurrently, writes input, then closes stdin to send EOF:

```rust
let mut process = sandbox
    .command("python")
    .args(["-u", "/workspace/uppercase.py"])
    .stdin(Stdio::Piped)
    .stdout(Stdio::Piped)
    .stderr(Stdio::Piped)
    .spawn()
    .await?;

let mut stdin = process.take_stdin()
    .ok_or(Error::StreamUnavailable)?;
let stdout = process.take_stdout()
    .ok_or(Error::StreamUnavailable)?;
let stderr = process.take_stderr()
    .ok_or(Error::StreamUnavailable)?;

let stdout_task = tokio::spawn(collect(stdout));
let stderr_task = tokio::spawn(collect(stderr));

stdin.write_all(b"hello\n").await?;
stdin.write_all(b"from wasmer\n").await?;
stdin.close().await?;

let output = process.wait().await?.check()?;
let stdout = stdout_task.await??;
let stderr = stderr_task.await??;
```

If the entire input is already available and live output is unnecessary,
prefer the smaller captured form:

```ts
const output = await sandbox.command("python", {
  args: ["/workspace/uppercase.py"],
}).run({
  stdin: "hello\nfrom wasmer\n",
});
```

## 6. Drive an interactive Bash terminal

A PTY is requested explicitly because terminal semantics differ from ordinary
stdin/stdout pipes.

### Browser JavaScript with xterm.js

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["wasmer/bash@1.0.25"],
});

const process = await sandbox.command("bash", {
  args: ["--norc"],
}).spawn({
  terminal: { columns: 100, rows: 30 },
});

const terminal = process.terminal!;
const writer = terminal.writable.getWriter();

xterm.onData((text) => {
  void writer.write(new TextEncoder().encode(text));
});

xterm.onResize(({ cols, rows }) => {
  void terminal.resize(cols, rows);
});

const reader = terminal.readable.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  xterm.write(value);
}
```

### Rust

```rust
let mut process = sandbox
    .command("bash")
    .arg("--norc")
    .terminal(true)
    .spawn()
    .await?;

let terminal = process
    .take_terminal()
    .ok_or(Error::TerminalUnavailable)?;

terminal.resize(100, 30).await?;
// Connect terminal.reader() and terminal.writer() to the host UI.
```

Browser thread and PTY requirements are checked during preflight. A target
without PTY support returns a capability error before starting the process.

## 7. Manage a background worker

Process lifetime is not tied to a single `wait()` future.

```ts
const worker = await sandbox.command("python", {
  args: ["-u", "/workspace/worker.py"],
}).spawn({
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitUntilHealthy(worker.stdout!);
  await sendJobs(worker.stdin!);
} finally {
  await worker.terminate({ gracePeriodMs: 2_000 });
}
```

Forced shutdown is separate:

```ts
await worker.kill();
```

Closing the owning sandbox also stops any remaining worker. Dropping a handle
must not create an invisible process that the application can no longer
control.

## 8. Start and connect to an HTTP service

This is the embedded equivalent of a sandbox provider's port or preview
feature. The portable path connects through the SDK; capable native targets
may additionally expose a loopback URL.

### JavaScript

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["namespace/http-app@<tested-pin>"],
});

const server = await sandbox.command("serve", {
  args: ["--host", "0.0.0.0", "--port", "8080"],
}).spawn();

try {
  await sandbox.ports.wait(8080, { timeoutMs: 10_000 });

  const connection = await sandbox.ports.connect(8080);
  await writeHttpRequest(connection, "GET /health HTTP/1.1\r\nHost: app\r\n\r\n");
  const response = await readHttpResponse(connection);
  console.log(response.status);
} finally {
  await server.terminate();
}
```

On a Node.js or native host that supports local forwarding:

```ts
await using forward = await sandbox.ports.forward(8080, {
  host: "127.0.0.1",
});

console.log(forward.url.href); // A loopback URL, not a public deployment URL.
```

### Rust

```rust
let mut server = sandbox
    .command("serve")
    .args(["--host", "0.0.0.0", "--port", "8080"])
    .spawn()
    .await?;

sandbox
    .ports()
    .wait(8080, Duration::from_secs(10))
    .await?;

let mut connection = sandbox.ports().connect(8080).await?;
// Read and write the application protocol over `connection`.

server.terminate(Duration::from_secs(2)).await?;
```

## 9. Run a PostgreSQL package

A database is not special to the SDK. It is a package command, a writable
directory, a background process, and a port. Package-specific initialization
still belongs to the package.

The exact PostgreSQL package and command below are placeholders until Phase 3
selects a tested registry package:

```ts
const POSTGRES = "namespace/postgres@<tested-pin>";

const data = await Directory.create();

const check = await wasmer.preflight({
  packages: [POSTGRES],
  limits: { memoryBytes: 1024 * 1024 * 1024 },
});
check.requireCompatible();

await using sandbox = await wasmer.createSandbox({
  packages: [POSTGRES],
  mounts: [
    {
      guest: "/var/lib/postgresql/data",
      directory: data,
      mode: "read-write",
    },
  ],
  env: {
    POSTGRES_USER: "app",
    POSTGRES_DB: "app",
    // This value is guest-readable; it is not an opaque secret.
    POSTGRES_PASSWORD: password,
  },
  limits: {
    memoryBytes: 1024 * 1024 * 1024,
    maxProcesses: 32,
  },
});

const postgres = await sandbox.command("postgres", {
  args: [
    "-D", "/var/lib/postgresql/data",
    "-p", "5432",
  ],
}).spawn();

try {
  await sandbox.ports.wait(5432, { timeoutMs: 30_000 });
  const connection = await sandbox.ports.connect(5432);
  await runPostgresProtocol(connection);
} finally {
  await postgres.terminate({ gracePeriodMs: 5_000 });
}
```

The example is important because it validates subprocesses, filesystem
persistence, signals, clocks, networking, and long-lived execution. If the
chosen PostgreSQL package requires a capability missing on a browser or iOS
build, `preflight()` must say so directly.

## 10. Control guest network access

Guest network is denied unless the application grants it.

```ts
await using offline = await wasmer.createSandbox({
  packages: ["namespace/app@<tested-pin>"],
  network: { mode: "disabled" },
});
```

Unrestricted host networking is a conspicuous opt-in and may not be available:

```ts
await using online = await wasmer.createSandbox({
  packages: ["namespace/app@<tested-pin>"],
  network: { mode: "host" },
});
```

Restricted egress is requested only when the target can enforce it:

```ts
const policy = {
  mode: "restricted" as const,
  allow: [
    { protocol: "tcp", host: "api.example.com", port: 443 },
  ],
};

const report = await wasmer.preflight({
  packages: ["namespace/app@<tested-pin>"],
  network: policy,
  minimumEnforcement: "hard",
});

report.requireCompatible();

await using sandbox = await wasmer.createSandbox({
  packages: ["namespace/app@<tested-pin>"],
  network: policy,
  minimumEnforcement: "hard",
});
```

There is no silent fallback from restricted egress to unrestricted sockets.
Registry downloads are host control-plane traffic and are configured
separately from guest network policy.

## 11. Apply time, memory, and output limits

Limits are part of creation or execution, not a separate policy language.

### JavaScript

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
  limits: {
    memoryBytes: 128 * 1024 * 1024,
    filesystemBytes: 16 * 1024 * 1024,
    maxProcesses: 1,
  },
});

const output = await sandbox.command("python", {
  args: ["-c", "while True: print('x' * 1024)"],
}).run({
  timeoutMs: 1_000,
  outputBytes: 64 * 1024,
});

console.log({
  exitCode: output.exitCode,
  truncated: output.stdout.truncated,
  usage: output.usage,
});
```

### Rust

```rust
let sandbox = wasmer
    .sandbox()
    .package("python/python@3.12")
    .memory_limit(128 * 1024 * 1024)
    .filesystem_limit(16 * 1024 * 1024)
    .max_processes(1)
    .start()
    .await?;

let output = sandbox
    .command("python")
    .args(["-c", "while True: print('x' * 1024)"])
    .timeout(Duration::from_secs(1))
    .output_limit(64 * 1024)
    .output()
    .await?;
```

`Output.reason` distinguishes a guest exit, timeout, termination, and limit
event while retaining bounded diagnostics. Calling `check()` turns an
unsuccessful reason into a typed error. If a requested hard limit is not
enforceable, the call fails before running when `minimumEnforcement` requires
it.

## 12. Cancel work without losing control

JavaScript supports familiar cancellation while retaining explicit process
ownership:

```ts
const controller = new AbortController();
const process = await sandbox.command("python", {
  args: ["/workspace/task.py"],
}).spawn();

setTimeout(() => controller.abort(), 1_000);

try {
  await process.wait({ signal: controller.signal });
} catch (error) {
  if (controller.signal.aborted) {
    await process.terminate({ gracePeriodMs: 500 });
  }
  throw error;
}
```

Aborting `wait()` cancels the wait, not the process. The caller still owns the
process and chooses graceful termination or a forced kill. Captured `run()`
cancellation remains a Phase 3 design proof because cancelling the host wait
must not make process ownership ambiguous. Foreign-future cancellation alone
is insufficient because Python, Swift, Rust, and JavaScript cancel
differently.

## 13. Snapshot and branch a workspace

Snapshots make experimental work cheap without claiming to clone live process
memory.

### JavaScript

```ts
await using base = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
  files: {
    "/workspace/app.py": "print('base')",
  },
  metadata: {
    project: "demo",
  },
});

(await base.command("python", {
  args: ["/workspace/app.py"],
}).run()).check();

const checkpoint = await base.snapshot();

await using experimentA = await wasmer.createSandbox({
  snapshot: checkpoint,
});
await using experimentB = await base.fork();

await experimentA.fs.writeText("/workspace/config.txt", "strategy=A");
await experimentB.fs.writeText("/workspace/config.txt", "strategy=B");
```

### Rust

```rust
let checkpoint = base.snapshot().await?;

let experiment_a = wasmer
    .sandbox()
    .snapshot(checkpoint.clone())
    .start()
    .await?;

let experiment_b = base.fork().await?;
```

The package lock and files are reproduced. Running processes, open sockets,
port forwards, and native host mounts are not.

## 14. Share a portable directory

A `Directory` can be an input bundle, dependency cache, database volume, or
artifact exchange without exposing a host path.

```ts
const shared = await Directory.create({
  "input.json": JSON.stringify({ values: [1, 2, 3] }),
});

await using producer = await wasmer.createSandbox({
  packages: ["namespace/producer@<tested-pin>"],
  mounts: [
    { guest: "/shared", directory: shared, mode: "read-write" },
  ],
});

(await producer.command("produce", {
  args: ["/shared/input.json", "/shared/output.bin"],
}).run()).check();

await using consumer = await wasmer.createSandbox({
  packages: ["namespace/consumer@<tested-pin>"],
  mounts: [
    { guest: "/shared", directory: shared, mode: "read-only" },
  ],
});

const output = await consumer.command("inspect", {
  args: ["/shared/output.bin"],
}).run();
```

Concurrent read-write sharing has explicit filesystem consistency semantics.
For branch-style isolation, use a snapshot or cloned directory instead.

## 15. Mount source code on a native host

Node.js and native Rust can deliberately grant a host directory. It is
read-only by default and unavailable in browser builds.

### Node.js

```ts
await using sandbox = await wasmer.createSandbox({
  packages: ["namespace/compiler@<tested-pin>"],
  mounts: [
    {
      guest: "/src",
      host: { path: "/absolute/path/to/project/src" },
      mode: "read-only",
    },
  ],
});

const output = await sandbox.command("compile", {
  args: ["/src/main.c", "-o", "/workspace/main.wasm"],
}).run();
```

### Rust

```rust
let source = HostDirectory::open("/absolute/path/to/project/src")?;

let sandbox = wasmer
    .sandbox()
    .package("namespace/compiler@<tested-pin>")
    .host_mount("/src", source, MountMode::ReadOnly)
    .start()
    .await?;
```

The guest output goes to `/workspace`; source code is not writable unless the
application consciously changes the mount mode.

## 16. Mount a browser File System API directory

The application obtains a browser handle during a user gesture, then gives the
SDK a scoped filesystem rather than an ambient host path.

```ts
import {
  BrowserFileSystem,
  Wasmer,
} from "@wasmer/sdk/browser";

const wasmer = await Wasmer.create();

const handle = await window.showDirectoryPicker({
  mode: "readwrite",
});

const project = await BrowserFileSystem.fromDirectoryHandle(handle, {
  access: "read-write",
});

const report = await wasmer.preflight({
  packages: ["python/python@3.12"],
  mounts: [{
    guest: "/project",
    fileSystem: project,
    mode: "read-write",
  }],
});
report.requireCompatible();

await using sandbox = await wasmer.createSandbox({
  packages: ["python/python@3.12"],
  mounts: [{
    guest: "/project",
    fileSystem: project,
    mode: "read-write",
  }],
});

const output = await sandbox.command("python", {
  args: ["-c", `
from pathlib import Path
source = Path("/project/input.txt").read_text()
Path("/project/output.txt").write_text(source.upper())
  `],
}).run();

output.check();
```

For origin-private persistent storage:

```ts
const opfsRoot = await navigator.storage.getDirectory();
const volume = await BrowserFileSystem.fromDirectoryHandle(opfsRoot, {
  access: "read-write",
});

await using sandbox = await wasmer.createSandbox({
  packages: ["namespace/database@<tested-pin>"],
  mounts: [{
    guest: "/data",
    fileSystem: volume,
    mode: "read-write",
  }],
});
```

The mount is live: guest changes are written through to the handle. If the
target cannot bridge asynchronous browser filesystem operations correctly,
preflight fails. An explicit portable copy is a different operation:

```ts
const copied = await BrowserFileSystem.importDirectory(handle);
```

Browser handles require a secure context and user-granted permission. A
read-only mount cannot write even if the browser handle itself has write
permission. Permission revocation is surfaced as a filesystem permission
error, not as an empty directory.

## 17. Select a package command without ambiguity

Package objects are useful when a package has several commands or two packages
export the same name.

### JavaScript

```ts
const tools = await wasmer.loadPackage("namespace/toolbox@1.2.3");

console.table(
  tools.manifest.commands.map((command) => ({
    name: command.name,
    runner: command.runner,
  })),
);

const formatter = tools.command("format");

await using sandbox = await wasmer.createSandbox({
  packages: [tools],
  files: {
    "/workspace/main.txt": "unformatted",
  },
});

const output = await sandbox.command(formatter, {
  args: ["/workspace/main.txt"],
}).run();
```

### Rust

```rust
let tools = wasmer
    .load_package("namespace/toolbox@1.2.3")
    .await?;

let formatter = tools.command("format")?;

let sandbox = wasmer
    .sandbox()
    .package(tools)
    .start()
    .await?;

sandbox
    .command(formatter)
    .arg("/workspace/main.txt")
    .output()
    .await?;
```

If `"format"` is ambiguous in the virtual `PATH`, using the explicit
`CommandRef` remains deterministic.

## 18. Build a safe shell tool for an AI agent

An agent tool is a small wrapper over a long-lived sandbox. The tool accepts a
program and argument list rather than an arbitrary shell string.

```ts
type ToolCall = {
  command: string;
  args: string[];
  stdin?: string;
};

const allowedCommands = new Set([
  "python",
  "rg",
  "formatter",
]);

async function runTool(call: ToolCall) {
  if (!allowedCommands.has(call.command)) {
    throw new Error(`Command not allowed: ${call.command}`);
  }

  const output = await sandbox.command(call.command, {
    args: call.args,
  }).run({
    stdin: call.stdin,
    timeoutMs: 15_000,
    outputBytes: 256 * 1024,
  });

  return {
    ok: output.ok,
    exitCode: output.exitCode,
    stdout: await output.stdout.text(),
    stderr: await output.stderr.text(),
    stdoutTruncated: output.stdout.truncated,
    stderrTruncated: output.stderr.truncated,
  };
}
```

The surrounding sandbox can add:

- a read-only project mount or seeded project snapshot;
- a writable `/workspace`;
- a fixed package lock;
- no guest network, or an enforceable allowlist;
- process, memory, time, filesystem, and output limits;
- a new snapshot before each risky step.

The wrapper intentionally does not expose `shell()` unless the product wants
the model to have shell-language authority.

## 19. Run isolated jobs concurrently

`Wasmer` is shareable; sandboxes are independent.

### JavaScript

```ts
const jobs = inputs.map(async (input) => {
  await using sandbox = await wasmer.createSandbox({
    packages: ["namespace/worker@<tested-pin>"],
    files: {
      "/workspace/input.json": JSON.stringify(input),
    },
    limits: {
      memoryBytes: 128 * 1024 * 1024,
      maxProcesses: 2,
    },
  });

  const output = await sandbox.command("worker", {
    args: ["/workspace/input.json"],
  }).run();

  return JSON.parse(await output.check().stdout.text());
});

const results = await Promise.all(jobs);
```

### Rust

```rust
let tasks = inputs.into_iter().map(|input| {
    let wasmer = wasmer.clone();

    tokio::spawn(async move {
        let sandbox = wasmer
            .sandbox()
            .package("namespace/worker@<tested-pin>")
            .file("/workspace/input.json", serde_json::to_vec(&input)?)
            .memory_limit(128 * 1024 * 1024)
            .max_processes(2)
            .start()
            .await?;

        let output = sandbox
            .command("worker")
            .arg("/workspace/input.json")
            .output()
            .await?
            .check()?;

        Result::<_>::Ok(serde_json::from_slice(output.stdout.as_bytes())?)
    })
});

let results = futures::future::try_join_all(tasks).await?;
```

The implementation may schedule work differently by target, but filesystem,
environment, process table, limits, and guest identity never leak between
sandboxes.

## 20. Inspect compatibility before presenting a feature

Applications can use preflight to make their UI honest.

```ts
const report = await wasmer.preflight({
  packages: ["namespace/database@<tested-pin>"],
  limits: {
    memoryBytes: 512 * 1024 * 1024,
    maxProcesses: 16,
  },
  network: { mode: "disabled" },
  minimumEnforcement: "hard",
});

if (!report.compatible) {
  renderUnavailable({
    title: "This package cannot run on this device",
    issues: report.issues.map((issue) => ({
      capability: issue.capability,
      reason: issue.message,
      remediation: issue.remediation,
    })),
  });
} else {
  renderRunButton();
}
```

Useful issues include:

- package needs WASIX subprocess support absent from the target build;
- threads require browser cross-origin isolation;
- a requested native host mount is unavailable in a browser;
- a requested live browser filesystem provider cannot be bridged safely;
- hard memory enforcement is unavailable;
- the package runner URI is unsupported;
- restricted networking cannot be enforced on the selected target.

## 21. What Phase 3 should turn into tests

Each example above should become one or more conformance fixtures. The first
implementation milestone is not “all examples compile”; it is a vertical slice:

1. instantiate `Wasmer`;
2. resolve one pinned package;
3. create a short-lived sandbox and run one command with bytes, text, status,
   timeout, and deterministic cleanup;
4. keep a sandbox open and run two commands against the same files;
5. expose the same behavior in browser JavaScript, Node.js, Python, and Swift;
6. mount an OPFS root and a user-selected browser directory through the
   filesystem-provider contract;
7. then add streams, PTYs, services, network policy, and snapshots in measured
   increments.

The PostgreSQL and EdgeJS examples are especially valuable compatibility
probes, but their exact package command lines must come from tested package
manifests during implementation.
