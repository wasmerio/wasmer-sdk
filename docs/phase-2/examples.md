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
const client = new Wasmer();
```

It captures the current project root and uses `.wasmer` beneath it for
content-addressed packages and target-partitioned compiled artifacts.

An explicit location is equally simple:

```ts
const client = new Wasmer({
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
const client = new Wasmer({
  cache: {
    namespace: "sandbox-examples",
    packages: true,
    compiled: true,
  },
});
```

See the complete [cache design](cache-design.md). The remaining snippets assume
that `client` has already been created.

## 1. Run Python in a short-lived sandbox

This is the shortest useful path: create a sandbox with a package, run one
command, capture output, and clean up. It uses the same object model as every
longer workflow.

### JavaScript

```ts
import { Wasmer } from "@wasmer/sdk";

const client = new Wasmer();

await using sandbox = await client.sandboxes.create({
  packages: ["python/python@3.12"],
});

const output = await sandbox.command(
  "python",
  ["-c", "print(sum(n * n for n in range(10)))"],
).run({
  check: true,
  timeoutMs: 5_000,
});

console.log(output.text().trim()); // 285
```

### Rust

```rust
use std::time::Duration;
use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;

    let sandbox = wasmer
        .sandboxes().create()
        .package("python/python@3.12")
        .await?;

    let output = sandbox
        .command("python")
        .args(["-c", "print(sum(n * n for n in range(10)))"])
        .timeout(Duration::from_secs(5))
        .output()
        .await?
        .check()?;

    println!("{}", output.text()?.trim());
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
const edgejs = await client.packages.load(
  "wasmer/edgejs-quickjs@0.0.3",
);

await using sandbox = await client.sandboxes.create({
  packages: [edgejs],
  files: {
    "main.js": `
      const name = process.argv[2] ?? "world";
      console.log(JSON.stringify({ greeting: \`Hello, \${name}\` }));
    `,
  },
});

const output = await sandbox
  .command(edgejs, ["main.js", "Ada"])
  .run({ check: true });

const value = JSON.parse(output.text());
console.log(value.greeting);
```

### Rust host

```rust
let source = r#"
    const name = process.argv[2] ?? "world";
    console.log(JSON.stringify({ greeting: `Hello, ${name}` }));
"#;

let edgejs = wasmer
    .packages()
    .load("wasmer/edgejs-quickjs@0.0.3")
    .await?;

let sandbox = wasmer
    .sandboxes().create()
    .package(edgejs.clone())
    .file("/workspace/main.js", source.as_bytes())
    .await?;

let output = sandbox
    .command(edgejs)
    .args(["/workspace/main.js", "Ada"])
    .output()
    .await?
    .check()?;

sandbox.close().await?;
```

The exact EdgeJS command contract remains a Phase 3 compatibility test. The
important SDK property is that no JavaScript-specific branch is involved.

## 3. Install packages into a live sandbox

Packages can be supplied at creation or installed later. Both paths use the
same resolver and cache. Dynamic installation is useful when an agent or
application discovers the required tool after the sandbox already exists.

### JavaScript

```ts
await using sandbox = await client.sandboxes.create({
  env: {
    APP_ENV: "test",
  },
  limits: {
    memoryBytes: 512 * 1024 * 1024,
    maxProcesses: 8,
  },
});

const python = await sandbox.installPackage("python/python@3.12");
await sandbox.installPackage("wasmer/bash@1.0.25", {
  asShell: "bash",
});

await sandbox.fs.writeText(
  "build.py",
  `
from pathlib import Path
Path("/workspace/result.txt").write_text("built in " + __import__("os").environ["APP_ENV"])
`,
);

await sandbox
  .command(python.command("python"), ["build.py"])
  .run({ check: true });

const listing = await sandbox
  .sh`wc -c result.txt && cat result.txt`
  .run({ check: true });

console.log(listing.text());
```

### Rust

```rust
let sandbox = wasmer
    .sandboxes().create()
    .env("APP_ENV", "test")
    .memory_limit(512 * 1024 * 1024)
    .max_processes(8)
    .await?;

let python = sandbox
    .install_package("python/python@3.12")
    .await?;
sandbox
    .install_package("wasmer/bash@1.0.25")
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
    .command(python.command("python")?)
    .arg("/workspace/build.py")
    .output()
    .await?
    .check()?;

let listing = sandbox
    .command("bash")
    .args([
        "-lc",
        "wc -c /workspace/result.txt && cat /workspace/result.txt",
    ])
    .output()
    .await?
    .check()?;
```

The shell comes from the explicitly installed Bash package. It is not an
ambient sandbox facility. Values interpolated through the `sh` tag become
escaped single arguments; only `shell(script)` treats its complete input as
opaque shell syntax.

## 4. Treat files as inputs and artifacts

Binary files are first-class. A sandbox need not encode them through strings
or base64.

### JavaScript

```ts
const input = new Uint8Array(await fetch("/photo.png").then((r) =>
  r.arrayBuffer()
));

await using sandbox = await client.sandboxes.create({
  packages: ["namespace/image-tools@<tested-pin>"],
  files: {
    "input.png": input,
    "config.json": JSON.stringify({ width: 320 }),
  },
  limits: {
    filesystemBytes: 64 * 1024 * 1024,
  },
});

await sandbox.command("resize", [
  "--config", "config.json",
  "input.png",
  "output.webp",
]).run({ check: true });

const artifact = await sandbox.fs.readFile("output.webp");
```

### Rust

```rust
let sandbox = wasmer
    .sandboxes().create()
    .package("namespace/image-tools@<tested-pin>")
    .file("/workspace/input.png", image_bytes)
    .file("/workspace/config.json", br#"{"width":320}"#)
    .filesystem_limit(64 * 1024 * 1024)
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
await using sandbox = await client.sandboxes.create({
  packages: ["python/python@3.12"],
  files: {
    "progress.py": `
import time
for i in range(5):
    print(f"step={i}", flush=True)
    time.sleep(0.2)
`,
  },
});

const process = await sandbox
  .command("python", ["-u", "progress.py"])
  .spawn({ outputBytes: 1024 * 1024 });

for await (const line of process.stdout!.lines()) {
  console.log(line);
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
await using sandbox = await client.sandboxes.create({
  packages: ["python/python@3.12"],
  files: {
    "uppercase.py": `
import sys
for line in sys.stdin:
    print(line.rstrip().upper(), flush=True)
`,
  },
});

const process = await sandbox.command(
  "python",
  ["-u", "uppercase.py"],
).spawn({
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

async function collectLines(stream: ReadableBytes): Promise<string> {
  let text = "";
  for await (const line of stream.lines({ keepNewline: true })) {
    text += line;
  }
  return text;
}

const stdoutPromise = collectLines(process.stdout!);
const stderrPromise = collectLines(process.stderr!);

await process.stdin!.write("hello\n");
await process.stdin!.write("from wasmer\n");
await process.stdin!.close(); // Sends EOF; it does not terminate the process.

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
const output = await sandbox.command("python", ["uppercase.py"]).run({
  check: true,
  stdin: "hello\nfrom wasmer\n",
});
```

## 6. Drive an interactive Bash terminal

A PTY is requested explicitly because terminal semantics differ from ordinary
stdin/stdout pipes.

### Browser JavaScript with xterm.js

```ts
await using sandbox = await client.sandboxes.create({
  packages: ["wasmer/bash@1.0.25"],
});

const process = await sandbox.command("bash", ["--norc"]).spawn({
  terminal: { columns: 100, rows: 30 },
});

const terminal = process.terminal!;

xterm.onData((text) => {
  void terminal.writable.write(text);
});

xterm.onResize(({ cols, rows }) => {
  void terminal.resize(cols, rows);
});

for await (const value of terminal.readable) {
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
const worker = await sandbox.command(
  "python",
  ["-u", "worker.py"],
).spawn({
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
await using sandbox = await client.sandboxes.create({
  packages: ["namespace/http-app@<tested-pin>"],
});

const server = await sandbox
  .command("serve", ["--host", "0.0.0.0", "--port", "8080"])
  .spawn();

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

const check = await client.preflight({
  packages: [POSTGRES],
  limits: { memoryBytes: 1024 * 1024 * 1024 },
});
check.requireCompatible();

await using sandbox = await client.sandboxes.create({
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

const postgres = await sandbox.command(
  "postgres",
  [
    "-D", "/var/lib/postgresql/data",
    "-p", "5432",
  ],
).spawn();

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
await using offline = await client.sandboxes.create({
  packages: ["namespace/app@<tested-pin>"],
  network: { mode: "disabled" },
});
```

Unrestricted host networking is a conspicuous opt-in and may not be available:

```ts
await using online = await client.sandboxes.create({
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

const report = await client.preflight({
  packages: ["namespace/app@<tested-pin>"],
  network: policy,
  minimumEnforcement: "hard",
});

report.requireCompatible();

await using sandbox = await client.sandboxes.create({
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
await using sandbox = await client.sandboxes.create({
  packages: ["python/python@3.12"],
  limits: {
    memoryBytes: 128 * 1024 * 1024,
    filesystemBytes: 16 * 1024 * 1024,
    maxProcesses: 1,
  },
});

const output = await sandbox.command(
  "python",
  ["-c", "while True: print('x' * 1024)"],
).run({
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
    .sandboxes().create()
    .package("python/python@3.12")
    .memory_limit(128 * 1024 * 1024)
    .filesystem_limit(16 * 1024 * 1024)
    .max_processes(1)
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
const process = await sandbox.command("python", ["task.py"]).spawn();

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

## 13. Share a portable directory

A `Directory` can be an input bundle, dependency cache, database volume, or
artifact exchange without exposing a host path.

```ts
const shared = await Directory.create({
  "input.json": JSON.stringify({ values: [1, 2, 3] }),
});

await using producer = await client.sandboxes.create({
  packages: ["namespace/producer@<tested-pin>"],
  mounts: [
    { guest: "/shared", directory: shared, mode: "read-write" },
  ],
});

await producer
  .command("produce", ["/shared/input.json", "/shared/output.bin"])
  .run({ check: true });

await using consumer = await client.sandboxes.create({
  packages: ["namespace/consumer@<tested-pin>"],
  mounts: [
    { guest: "/shared", directory: shared, mode: "read-only" },
  ],
});

const output = await consumer
  .command("inspect", ["/shared/output.bin"])
  .run({ check: true });
```

Concurrent read-write sharing has explicit filesystem consistency semantics.
For isolated copies, create or import a separate `Directory`.

## 14. Mount source code on a native host

Node.js and native Rust can deliberately grant a host directory. It is
read-only by default and unavailable in browser builds.

### Node.js

```ts
await using sandbox = await client.sandboxes.create({
  packages: ["namespace/compiler@<tested-pin>"],
  mounts: [
    {
      guest: "/src",
      host: { path: "/absolute/path/to/project/src" },
      mode: "read-only",
    },
  ],
});

const output = await sandbox
  .command("compile", ["/src/main.c", "-o", "main.wasm"])
  .run({ check: true });
```

### Rust

```rust
let source = HostDirectory::open("/absolute/path/to/project/src")?;

let sandbox = wasmer
    .sandboxes().create()
    .package("namespace/compiler@<tested-pin>")
    .host_mount("/src", source, MountMode::ReadOnly)
    .await?;
```

The guest output goes to `/workspace`; source code is not writable unless the
application consciously changes the mount mode.

## 15. Mount a browser File System API directory

The application obtains a browser handle during a user gesture, then gives the
SDK a scoped filesystem rather than an ambient host path.

```ts
import {
  BrowserFileSystem,
  Wasmer,
} from "@wasmer/sdk/browser";

const client = new Wasmer();

const handle = await window.showDirectoryPicker({
  mode: "readwrite",
});

const project = await BrowserFileSystem.fromDirectoryHandle(handle, {
  access: "read-write",
});

const report = await client.preflight({
  packages: ["python/python@3.12"],
  mounts: [{
    guest: "/project",
    fileSystem: project,
    mode: "read-write",
  }],
});
report.requireCompatible();

await using sandbox = await client.sandboxes.create({
  packages: ["python/python@3.12"],
  mounts: [{
    guest: "/project",
    fileSystem: project,
    mode: "read-write",
  }],
});

const output = await sandbox.command("python", [
  "-c",
  `
from pathlib import Path
source = Path("/project/input.txt").read_text()
Path("/project/output.txt").write_text(source.upper())
  `,
]).run({ check: true });
```

For origin-private persistent storage:

```ts
const opfsRoot = await navigator.storage.getDirectory();
const volume = await BrowserFileSystem.fromDirectoryHandle(opfsRoot, {
  access: "read-write",
});

await using sandbox = await client.sandboxes.create({
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

## 16. Select a package command without ambiguity

Package objects are useful when a package has several commands or two packages
export the same name.

### JavaScript

```ts
const tools = await client.packages.load("namespace/toolbox@1.2.3");

console.table(
  tools.manifest.commands.map((command) => ({
    name: command.name,
    runner: command.runner,
  })),
);

const formatter = tools.command("format");

await using sandbox = await client.sandboxes.create({
  packages: [tools],
  files: {
    "main.txt": "unformatted",
  },
});

const output = await sandbox
  .command(formatter, ["main.txt"])
  .run({ check: true });
```

### Rust

```rust
let tools = wasmer
    .packages()
    .load("namespace/toolbox@1.2.3")
    .await?;

let formatter = tools.command("format")?;

let sandbox = wasmer
    .sandboxes().create()
    .package(tools)
    .await?;

sandbox
    .command(formatter)
    .arg("/workspace/main.txt")
    .output()
    .await?;
```

If `"format"` is ambiguous in the virtual `PATH`, using the explicit
`CommandRef` remains deterministic.

## 17. Build a safe command tool for an AI agent

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

  const output = await sandbox.command(call.command, call.args).run({
    stdin: call.stdin,
    timeoutMs: 15_000,
    outputBytes: 256 * 1024,
  });

  return {
    ok: output.ok,
    exitCode: output.exitCode,
    stdout: output.stdout.text(),
    stderr: output.stderr.text(),
    stdoutTruncated: output.stdout.truncated,
    stderrTruncated: output.stderr.truncated,
  };
}
```

The surrounding sandbox can add:

- a read-only project mount or seeded `Directory`;
- a writable `/workspace`;
- exact package versions or content digests;
- no guest network, or an enforceable allowlist;
- process, memory, time, filesystem, and output limits;

The wrapper intentionally accepts argv rather than shell text. A product that
wants shell-language authority can configure an installed shell and expose
the escaped `sh` tag deliberately; opaque `shell(script)` should remain a
more privileged operation.

## 18. Run isolated jobs concurrently

`Wasmer` is shareable; sandboxes are independent.

### JavaScript

```ts
const jobs = inputs.map(async (input) => {
  await using sandbox = await client.sandboxes.create({
    packages: ["namespace/worker@<tested-pin>"],
    files: {
      "input.json": JSON.stringify(input),
    },
    limits: {
      memoryBytes: 128 * 1024 * 1024,
      maxProcesses: 2,
    },
  });

  const output = await sandbox
    .command("worker", ["input.json"])
    .run({ check: true });

  return JSON.parse(output.text());
});

const results = await Promise.all(jobs);
```

### Rust

```rust
let tasks = inputs.into_iter().map(|input| {
    let wasmer = wasmer.clone();

    tokio::spawn(async move {
        let sandbox = wasmer
            .sandboxes().create()
            .package("namespace/worker@<tested-pin>")
            .file("/workspace/input.json", serde_json::to_vec(&input)?)
            .memory_limit(128 * 1024 * 1024)
            .max_processes(2)
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

## 19. Inspect compatibility before presenting a feature

Applications can use preflight to make their UI honest.

```ts
const report = await client.preflight({
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

## 20. What Phase 3 should turn into tests

Each example above should become one or more conformance fixtures. The first
implementation milestone is not “all examples compile”; it is a vertical slice:

1. instantiate `Wasmer`;
2. resolve one pinned package;
3. create a short-lived sandbox and run one command with bytes, text, status,
   timeout, and deterministic cleanup;
4. keep a sandbox open and run two commands against the same files;
5. install a package after creation and use one of its commands;
6. expose the same behavior in browser JavaScript, Node.js, Python, and Swift;
7. mount an OPFS root and a user-selected browser directory through the
   filesystem-provider contract;
8. then add streams, PTYs, services, and network policy in measured
   increments.

The PostgreSQL and EdgeJS examples are especially valuable compatibility
probes, but their exact package command lines must come from tested package
manifests during implementation.
