# Phase 1 decision log

Status: draft for review  
Last updated: 2026-07-27

This is the short ledger of architectural decisions. The full rationale and
consequences are in [architecture.md](architecture.md).

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | Build the product around `Package`, `Sandbox`, `Process`, and `Directory` rather than exposing low-level Wasm instances as the primary API. | Accepted |
| D-002 | Treat “universal” as one Rust API and behavioral contract compiled for each target with the appropriate Wasmer Cargo features, not one binary or identical capabilities on every host. | Accepted |
| D-003 | Put policy, package, lifecycle, error, and execution logic in the public Rust API, which calls the Wasmer Rust API directly. | Accepted |
| D-004 | Use UniFFI for Swift, Python, and later Kotlin bindings; use `wasm-bindgen` plus handwritten TypeScript for browser and Node.js. | Accepted |
| D-005 | Keep the UniFFI and `wasm-bindgen` façades thin: both call the public Rust API rather than a separate runtime or backend abstraction. | Accepted |
| D-006 | Make the SDK instance-based. Do not rely on mutable process-wide global initialization in the core design. | Accepted |
| D-007 | Make a sandbox a stateful virtual OS context containing a filesystem, package command set, process table, policy, and optional virtual network for its explicit lifetime. | Accepted |
| D-008 | Make packages immutable and content-addressed after resolution. Keep mutable execution state in sandboxes. | Accepted |
| D-009 | Resolve package specifications to immutable content identities before execution and key caches by content plus engine identity. | Accepted |
| D-010 | Support WASI/WASIX command runners first, behind an extensible runner registry. Unknown runner URIs fail explicitly. | Accepted |
| D-011 | Deny host filesystem, host environment, networking, and host process access by default. Grants are explicit and scoped. | Accepted |
| D-012 | Report capabilities enabled by the current target build and limit-enforcement strength at runtime. Unsupported requested guarantees fail closed; they never silently degrade. | Accepted |
| D-013 | Use bounded byte-oriented I/O primitives at the Rust/FFI boundary. Build guaranteed async-iterable byte streams with Web Stream adapters in JavaScript, async iterators in Python, and `AsyncSequence` in Swift. | Accepted |
| D-014 | Use explicit process cancellation and termination APIs; do not depend on foreign-future cancellation as the only control path. | Accepted |
| D-015 | Keep registry credentials and content acquisition in the trusted host. Never inject credentials into a guest implicitly. | Accepted |
| D-016 | State clearly that embedded Wasm/WASIX is an in-process, userspace isolation boundary, not a VM or kernel boundary. | Accepted |
| D-017 | Do not introduce a Wasmer runtime-backend trait or host-adapter layer. Select Wasmer behavior with Cargo features and small target-specific modules only where compilation requires them. | Accepted |
| D-019 | Do not claim that every registry package runs on every target. Provide package preflight, capability diagnostics, and a tested compatibility matrix. | Accepted |
| D-020 | Ship handwritten idiomatic public veneers over generated bindings rather than exposing generated UniFFI code as the whole product API. | Accepted |
| D-021 | Version the SDK contract and compiled cache identity separately. | Accepted |
| D-022 | Make cross-target conformance tests and event traces release gates. | Accepted |
| D-023 | Keep Wasmer Edge/remote execution out of the Phase 1 SDK. A future remote client should be a separate layer rather than a runtime backend hidden inside the Rust API. | Accepted |
| D-024 | Treat iOS package download/execution as both a technical and App Store policy risk; support bundled packages first and validate distribution policy separately. | Accepted |
| D-025 | Define a narrow, object-safe, asynchronous filesystem-provider trait in the public Rust API. `Directory`, native host directories, browser File System API handles, and application-defined providers mount through it; it is not a runtime backend or general host adapter. | Accepted |
| D-026 | Treat a requested browser filesystem mount as live only when the target can implement it correctly. Copy/import into a portable `Directory` is an explicit alternative, never a silent fallback. | Accepted |
| D-027 | Default native desktop and Node.js clients to a project-local `.wasmer` cache rooted at the working directory captured during client creation; allow explicit location, memory-only, read-only, and disabled modes. | Accepted |
| D-028 | Store package blobs by cryptographic content digest and partition compiled artifacts by target plus a complete engine/code-generation fingerprint. | Accepted |
| D-029 | Treat `.wasmer` as disposable optimization state. Removing it may repeat downloads and compilation but does not alter guest-visible semantics. | Accepted |
| D-030 | Never deserialize attacker-controlled native compiled artifacts. Project-local compiled entries require authenticated local provenance or are treated as misses. | Accepted |
| D-031 | Allow a live sandbox to install additional Wasmer packages atomically. Installation resolves and verifies content, extends the package command set, and never executes an entrypoint or install script implicitly. | Accepted |

## Questions intentionally deferred

- Exact public names and convenience methods belong to Phase 2.
- The exact Wasmer features for each release target require build and runtime
  proofs.
- The iOS-compatible Wasmer feature selection and WASIX coverage require a
  device prototype.
- Fine-grained network allowlists require a concrete virtual-network
  implementation and should not be promised until it exists.
- PTY behavior, background services, and host-command bindings require focused
  proofs of concept.
