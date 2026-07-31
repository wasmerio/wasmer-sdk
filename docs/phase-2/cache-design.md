# Phase 2: project-local package and compilation cache

Status: complete draft for review  
Last updated: 2026-07-27

## 1. Decision

On native desktop hosts and Node.js, a `Wasmer` client uses a project-local
`.wasmer` directory by default. The location is resolved once when the client
is created and can be customized, made read-only, replaced with memory
storage, or disabled.

The cache stores two fundamentally different things:

1. portable package content, keyed by cryptographic content digest;
2. compiled artifacts, partitioned by target and keyed by a complete
   engine/code-generation fingerprint.

A cache is disposable. Deleting it may make the next run download or compile
again, but does not alter guest-visible program semantics.

Phase 3 implements registry and package caching for JavaScript. Compiled
WebAssembly caching remains host-managed and is intentionally outside the
JavaScript SDK cache.

## 2. Defaults

| Host | Default persistent storage | Notes |
| --- | --- | --- |
| Native Rust, Node.js, desktop Python/Swift | `<project-root>/.wasmer` | `project-root` defaults to the working directory captured during `Wasmer` creation. |
| Browser | Cache Storage under an SDK cache namespace | There is no host path. The namespace defaults to the current origin plus SDK contract version and can be customized. |
| iOS | Application cache container | A caller may supply an app-container URL; arbitrary host paths are unavailable. |
| Tests | Deterministic memory cache | Tests opt into filesystem behavior explicitly. |

Capturing the project root does not expose it to guests. It is host
control-plane configuration, independent of sandbox mounts and `cwd`.

The default native layout should be added to source control ignore rules:

```gitignore
.wasmer/
```

## 3. Client configuration

### JavaScript

Zero configuration uses the target default:

```ts
const wasmer = new Wasmer();
```

An explicit project root and cache:

```ts
const wasmer = new Wasmer({
  projectRoot: "/absolute/path/to/project",
  cache: {
    directory: ".wasmer",
    packages: true,
    compiled: true,
    maxBytes: 4 * 1024 * 1024 * 1024,
  },
});
```

A relative cache directory is resolved against `projectRoot`, not against a
working directory that may change later.

Other useful modes:

```ts
// Custom absolute location.
const shared = new Wasmer({
  cache: {
    directory: "/var/cache/my-application/wasmer",
  },
});

// Process-local cache only.
const ephemeral = new Wasmer({
  cache: "memory",
});

// No package or compilation cache.
const uncached = new Wasmer({
  cache: false,
});

// Read existing entries but do not modify the cache.
const readOnly = new Wasmer({
  cache: {
    directory: ".wasmer",
    readOnly: true,
  },
});
```

Proposed options:

```ts
export interface WasmerOptions {
  projectRoot?: string;
  registry?: RegistryOptions;
  cache?: false | "memory" | CacheOptions;
  log?: LogSink;
  defaults?: {
    limits?: Limits;
    network?: NetworkPolicy;
  };
}

export interface CacheOptions {
  directory?: string;
  namespace?: string;
  packages?: boolean;
  compiled?: boolean;
  readOnly?: boolean;
  maxBytes?: number;
  compiledTrust?: "local-authenticated" | "disabled";
}
```

`directory` applies to filesystem hosts. `namespace` applies to browser and
other key/value stores. Target veneers reject inapplicable combinations rather
than ignoring them.

### Rust

```rust
let wasmer = Wasmer::builder()
    .project_root("/absolute/path/to/project")
    .cache(
        CacheConfig::project(".wasmer")
            .packages(true)
            .compiled(true)
            .max_bytes(4 * GIB),
    )
    .build()?;
```

Defaults remain concise:

```rust
let wasmer = Wasmer::new(WasmerConfig::default())?;
```

The default configuration captures `std::env::current_dir()` once and uses
`.wasmer` beneath it on native desktop targets.

### Browser

```ts
const wasmer = new Wasmer({
  cache: {
    namespace: "my-editor",
    packages: true,
    compiled: true,
    maxBytes: 512 * 1024 * 1024,
  },
});
```

The browser implementation uses origin-scoped Cache Storage behind the same
logical cache contract. It does not pretend `.wasmer` is a browser filesystem
path.

## 4. On-disk layout

The concrete layout is versioned and internal, but it should remain
inspectable:

```text
.wasmer/
├── README
└── cache-v1/
    ├── packages/
    │   ├── blobs/
    │   │   └── sha256/
    │   │       └── ab/
    │   │           └── abcdef...webc
    │   ├── trees/
    │   │   └── sha256/
    │   │       └── 12/
    │   │           └── 123456...
    │   └── refs/
    │       └── <registry-id>/
    │           └── <specifier-hash>.json
    ├── compiled/
    │   ├── x86_64-apple-darwin/
    │   │   └── <engine-fingerprint>/
    │   │       └── modules/
    │   │           └── sha256/
    │   │               └── 78/
    │   │                   ├── 789abc...artifact
    │   │                   ├── 789abc...json
    │   │                   └── 789abc...auth
    │   ├── aarch64-apple-ios/
    │   │   └── <engine-fingerprint>/
    │   ├── wasm32-browser/
    │   │   └── <engine-fingerprint>/
    │   └── wasm32-node/
    │       └── <engine-fingerprint>/
    ├── indexes/
    ├── locks/
    └── tmp/
```

The browser store uses equivalent logical buckets rather than literal
directories.

The target directory is intentionally human-readable. The engine fingerprint
directory is a digest; its adjacent metadata records the complete inputs that
produced it.

## 5. Package cache

Package content is portable and shared across target partitions.

### Blob identity

WEBC packages, dependencies, and other admitted immutable assets are stored by
SHA-256 digest:

```text
packages/blobs/sha256/<first-two-hex>/<full-digest>.webc
```

The SDK verifies the digest every time content crosses from untrusted storage
into the trusted resolver. A corrupted entry is quarantined or removed and
treated as a miss.

### Registry references

A registry reference such as `python/python@3.12` is not a content key.
`packages/refs` is only an index from:

```text
registry identity + normalized specifier + resolution policy
```

to the exact resolved version and content digest.

Mutable or unversioned references obey refresh policy. Exact versions and
digests remain stable, but their content is still integrity-checked.

### Local packages

A local WEBC file is read, validated, hashed, and admitted to the same blob
store as a registry package. A path-to-digest hint may use file identity,
length, and modification time to avoid unnecessary reads, but any detected
change causes rehashing. The path itself never becomes package identity.

### Extracted trees

If package execution benefits from a prepared tree, it is a derived cache
keyed by:

```text
package digest + extraction contract version
```

Extraction remains bounded by entry count, total bytes, path depth, and
symlink policy.

## 6. Compiled artifact cache

Compiled artifacts are never shared merely because the original Wasm module
has the same digest. They are stored first by target, then by engine
fingerprint.

### Target key

The target key distinguishes at least:

- architecture;
- operating system or JavaScript host profile;
- ABI and pointer width;
- browser versus Node.js when their compilation or worker contracts differ.

Examples:

```text
x86_64-unknown-linux-gnu
aarch64-apple-darwin
aarch64-apple-ios
wasm32-browser
wasm32-node
```

### Engine fingerprint

The engine fingerprint includes every input capable of changing generated
code or serialized module compatibility:

- Wasmer version and SDK runtime build identity;
- selected Wasmer backend/compiler;
- target triple and detected CPU features;
- enabled WebAssembly proposals and validation features;
- compiler optimization and canonicalization settings;
- engine tunables and memory/table styles;
- middleware, metering, instrumentation, and transformations;
- runner ABI and relevant WASI/WASIX contract;
- compiled-cache schema version.

Runtime-only sandbox values such as arguments or environment variables do not
belong in this fingerprint unless they alter compilation.

### Module key

Within that partition, a module entry is keyed by:

```text
SHA-256(
  original module digest
  + engine fingerprint
  + transformation input digests
)
```

Package identity is recorded as provenance but is not required in the key.
Two packages containing identical modules under the same compilation contract
can reuse the artifact.

### Lookup

```text
resolve exact package content
  -> locate module bytes
  -> calculate module digest
  -> calculate target key
  -> calculate engine fingerprint
  -> lookup authenticated artifact
       hit  -> deserialize and instantiate
       miss -> validate, compile, serialize, authenticate, atomically store
```

An incompatible or unreadable artifact is a cache miss, not an execution
failure, unless compilation itself subsequently fails.

## 7. Compiled-cache trust

This distinction is essential for a sandbox product:

- a WEBC or Wasm blob is untrusted input that Wasmer validates before
  compilation;
- a serialized native module contains executable machine code.

Wasmer documents module deserialization as unsafe because malicious serialized
bytes can inject code into executable memory. A SHA-256 stored beside an
artifact detects accidental corruption but does not authenticate an attacker
who can replace both files.

Therefore native compiled entries use `local-authenticated` trust by default:

1. the SDK creates a per-user cache-authentication key outside the project
   checkout using platform-appropriate private application storage;
2. every artifact is authenticated together with its full metadata, target,
   engine fingerprint, and module digest;
3. an entry without a valid authenticator is never deserialized;
4. copying `.wasmer` to another machine yields safe cache misses and
   recompilation unless an explicit trusted distribution mechanism exists.

If a target cannot protect an authentication key, persistent compiled loading
defaults to disabled while package caching remains enabled. The application
may still use a process-local compiled cache.

Browser-produced `WebAssembly.Module` caching follows the browser's
structured-clone and origin isolation model. The browser adapter still
partitions entries and rejects metadata/fingerprint mismatches.

The cache contains no registry token, guest secret, or host environment dump.
Guests never receive cache paths.

## 8. Concurrency and atomicity

Multiple application processes may share one `.wasmer` directory.

- Writers compile or download into uniquely named files under `tmp`.
- Complete entries are published with an atomic rename.
- Per-key locks deduplicate work when practical.
- Readers never observe partial artifacts.
- Stale locks are recoverable using owner and lease metadata.
- A process crashing during compilation leaves only disposable temporary
  files.
- Index updates are transactional or reconstructable from content entries.

The implementation must not hold a global cache lock while downloading,
compiling, or executing a guest.

## 9. Eviction

`maxBytes` applies to the complete cache unless separate package and compiled
budgets are configured later.

Eviction follows these rules:

- temporary and invalid entries first;
- least-recently-used derived compiled artifacts next;
- prepared package trees before canonical package blobs;
- package blobs last;
- entries actively leased by a client are not evicted;
- eviction never mutates sandbox files or mounted filesystems.

If space cannot be reclaimed, writes fail as cache writes while execution may
continue using in-memory results. Cache-write failure does not turn a
successfully compiled command into a guest failure.

## 10. Cache administration

The client exposes inspection and scoped maintenance:

```ts
const info = await client.cache.info();

await client.cache.prune({
  maxBytes: 2 * 1024 * 1024 * 1024,
});

await client.cache.clear({
  kind: "compiled",
  target: "wasm32-browser",
});
```

`clear()` is explicitly scoped; there is no implicit operation that removes
an arbitrary project root. Removing `.wasmer` manually is also supported when
no client is using it.

Useful diagnostics include:

- package blob hit/miss;
- registry-reference refresh;
- compiled artifact hit/miss;
- target and engine fingerprint;
- rejected/corrupt/untrusted entries;
- bytes used by package and compiled partitions;
- eviction and write failures.

## 11. Offline behavior

Exact package references can resolve offline when all required package content
is already cached:

```ts
const wasmer = new Wasmer({
  registry: { mode: "offline" },
  cache: {
    directory: ".wasmer",
    packages: true,
    compiled: true,
  },
});
```

A missing package blob produces an offline cache-miss error naming the package
reference or digest. A missing compiled artifact does not require network
access; it is compiled from the cached module bytes.

## 12. Mount interaction

The active cache directory is trusted host control-plane state.

- It is never mounted into a sandbox implicitly.
- A writable host mount containing the active cache directory is rejected by
  default because a guest could race cache creation or tamper with artifacts.
- An application requiring that unusual layout must choose a separate cache
  root or make a narrowly reviewed explicit override.
- The guest never sees `.wasmer` unless the application deliberately mounts or
  copies it into the guest filesystem.

## 13. Phase 3 proofs

1. A second native execution loads a compiled artifact without recompiling.
2. Browser reload reuses cached package content and any supported compiled
   browser representation.
3. The same package can have independent native, browser, Node.js, and iOS
   compiled partitions.
4. Changing Wasmer version, backend, CPU features, tunables, or instrumentation
   produces a miss.
5. Corruption, truncation, incompatible metadata, and invalid authentication
   produce safe misses.
6. An attacker-controlled compiled artifact is never passed to Wasmer
   deserialization.
7. Concurrent processes do not observe partial entries or corrupt indexes.
8. A local WEBC edit changes its digest and does not reuse stale package or
   compiled content.
9. Offline locked execution succeeds from package blobs even after compiled
   entries are removed.
10. Cache eviction never changes observable guest behavior.

## Primary references

- [Wasmer cache crate](https://docs.rs/wasmer-cache/latest/wasmer_cache/)
- [Wasmer module serialization and deserialization](https://docs.rs/wasmer/latest/wasmer/struct.Module.html)
- [Wasmer CLI cache directory option](https://docs.wasmer.io/runtime/cli/)
