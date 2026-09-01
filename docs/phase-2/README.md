# Phase 2: SDK design and developer experience

Status: complete draft for review  
Last updated: 2026-07-27

Phase 2 turns the Phase 1 architecture into an opinionated public SDK. The API
shown here is proposed, not implemented. Phase 3 will validate it with working
Rust, browser JavaScript, Node.js, Python, and Swift proofs of concept.

## Documents

- [SDK design](sdk-design.md) defines the public model, Rust and TypeScript
  surfaces, behavior, errors, and target differences.
- [Examples](examples.md) exercises the API against the workflows developers
  expect from modern sandbox products.
- [Cache design](cache-design.md) defines the project-local `.wasmer` package
  cache, target-partitioned compiled artifacts, trust, and eviction.
- [Sandbox SDK comparison](sandbox-sdk-comparison.md) analyzes Vercel, Modal,
  E2B, and Daytona and records why execution is sandbox-scoped.
- [Decision log](decisions.md) records the DX choices that should remain stable
  during implementation.

The Phase 1 [architecture](../phase-1/architecture.md) remains authoritative for
system boundaries and security claims. If an API convenience conflicts with an
architectural guarantee, the guarantee wins.

## The design in one minute

The SDK has one execution boundary:

```ts
const wasmer = new Wasmer();

await using sandbox = await wasmer.sandboxes.create({
  packages: ["python/python@=3.13.18"],
});

await sandbox.fs.writeText("main.py", "print(6 * 7)");
const result = await sandbox
  .command("python", ["main.py"])
  .run();
```

The equivalent Rust API follows Rust conventions rather than mechanically
copying JavaScript:

```rust
let sandbox = wasmer
    .sandboxes().create()
    .package("python/python@=3.13.18")
    .await?;

sandbox
    .fs()
    .write_text("/workspace/main.py", "print(6 * 7)")
    .await?;

let result = sandbox
    .command("python")
    .arg("/workspace/main.py")
    .run()
    .await?;
```

The model stays small:

```text
Wasmer ── resolves ──> Package
   │
   └── create ───────> Sandbox ── command() ──> Command
                                            ├── run() ──> Output
                                            └── spawn() ──> Process
```

`Command.run()` captures completed execution. `Command.spawn()` returns a live
process. `sandbox.installPackage()` can extend the package and command set
after creation. Shell behavior exists only when an installed package provides
a configured shell; JavaScript's `sh` tag escapes interpolated argument values,
while `shell(script)` is the explicit opaque-script form. Package resolution,
filesystem access, network access, and resource grants never happen implicitly.
Running one command is simply short-lived use of the same `Sandbox`; there is
no base `Wasmer.run()`.
