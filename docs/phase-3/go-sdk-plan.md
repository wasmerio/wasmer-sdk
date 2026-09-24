**Go SDK through UniFFI — implementation plan for review**

Prepared September 22, 2026 against `main` at `842f77425753005a27f18ae21a99a541d5215b86`, then approved for implementation. The implementation is on `codex/go-uniffi`; see the [Go guide](../../go/README.md) and [Node proxy deployment guide](../../go/proxy/README.md). Local macOS arm64 validation covers both link modes, race checks, Python/PostgreSQL/Edge.js workloads, and an external release consumer. The four-platform release matrix is configured in CI; publishing the first release and configuring the public domain remain deployment steps.

Updated September 23, 2026: commit the generated Go bindings and C header to avoid rebuilding the generator in CI. Native libraries remain outside Git. Normal builds check the recorded binding inputs/outputs; maintainers regenerate explicitly with `python3.13 go/scripts/build.py --release --generate-bindings` when those inputs change.

Reuse the Rust SDK's UniFFI facade, add a handwritten Go API, and publish complete source modules and native libraries in independent Go GitHub releases. The release-backed Go module proxy supports normal `go get`, plus an explicit native-library installation step. This requires hosting a discovery/proxy endpoint; archive download with a local module replacement is the alternative if we want to avoid that infrastructure.

**1. Existing foundation and the first compatibility gate**

- [`rust/uniffi`](../../rust/uniffi/Cargo.toml) already produces `cdylib`, `staticlib`, and `rlib`, using UniFFI **0.32.0**. Its exported objects cover packages, sandboxes, commands, processes, streams, filesystems, ports, and shutdown. Most operations are async and run through its existing Tokio runtime.
- [`python/scripts/build.py`](../../python/scripts/build.py) demonstrates library-based binding generation and target-dependent backend selection. [`swift/scripts/build.py`](../../swift/scripts/build.py) demonstrates static-library packaging. Reuse these patterns, building Go's artifacts from its own release commit.
- [`build-release.yml`](../../.github/workflows/build-release.yml) and [`sdk_release.py`](../../.github/scripts/sdk_release.py) already build independent components, validate platform sets, record source commits and checksums, and feed an immutable GitHub release upload. Extend this path.

The latest upstream Go generator is `v0.7.1+v0.31.0`, at `0b7fb4ceef12021bd7f790cc516fa9133e001813`. It targets UniFFI 0.31. The open [0.32 upgrade PR](https://github.com/NordSecurity/uniffi-bindgen-go/pull/98) reports incompatible metadata and supplies a port at `4f79e52bd8f518e5fa4d7acff9e586aee21e12a0` in `kixelated/uniffi-bindgen-go`.

Start with a bounded compatibility spike against that exact candidate revision. Validate the patch, pin its repository/revision and lockfile, and install the generator separately from the SDK workspace. Keep the shared UniFFI dependency at 0.32. Move to a compatible upstream release once available and tested. The PR also changes explicit configuration loading; verify crate-local `[bindings.go]` versus its global `--config` format before writing the build script.

The spike must generate bindings from the actual SDK library and run a local Wasm fixture through Go with both static and dynamic linking. Exercise async success/error returns, optional byte buffers including EOF, maps/records, object ownership, and shutdown. Passing a generator build alone is insufficient. Compatibility remains unproven until this runs.

**2. What lives in Git and what lives in a release**

| Location | Contents |
| --- | --- |
| `go/` in Git | `go.mod`, handwritten public API and linker glue, tests, examples, README, license, changelog, `version.txt`, and release URL descriptor |
| `go/scripts/` in Git | Build, generation, packaging, and artifact validation tools; pinned generator configuration |
| `go/cmd/wasmer-sdk/` in Git | Pure-Go native installer/build helper, with no import of the cgo SDK package |
| `go/internal/ffi/` in Git | Generated `.go` and `.h` alongside handwritten linker glue; generation inputs and hashes recorded in `go/bindings.json` |
| `go/Artifacts/`, `go/.build/` locally | Native libraries and assembled release module; ignored by Git |
| Go GitHub release | Complete Go module source ZIP, module metadata, four native archives, checksums, build metadata, and licenses |

Use independent version `0.1.0` initially and tag `wasmer-sdk-go-v0.1.0`, following the existing component convention. The Go module version is `v0.1.0`; the proxy maps it to that component tag.

Proposed release assets:

```text
wasmer-sdk-go-v0.1.0
  v0.1.0.zip                  # complete module: handwritten + generated source
  v0.1.0.mod                  # exact go.mod from that ZIP
  v0.1.0.info                 # Go version/time metadata
  wasmer-sdk-go-0.1.0-linux-amd64.tar.gz
  wasmer-sdk-go-0.1.0-linux-arm64.tar.gz
  wasmer-sdk-go-0.1.0-darwin-amd64.tar.gz
  wasmer-sdk-go-0.1.0-darwin-arm64.tar.gz
  release-metadata.json
  SHA256SUMS
```

Each native archive contains `static/libwasmer_sdk_uniffi.a`, `dynamic/libwasmer_sdk_uniffi.so` or `.dylib`, required redistributable dependencies, notices, and a target manifest. Record GOOS/GOARCH, Rust target, backend/features, OS/libc minimum, SDK source SHA, UniFFI version, and generator revision. Assemble source once and verify every target exposes the same binding interface.

Link these artifacts from the root README, `go/README.md`, release notes, and a checked-in `go/release.json` descriptor. The descriptor contains the component version, exact tag, release URL, and asset naming rules. Final checksums live in release metadata and an embedded native manifest in the source ZIP. This avoids needing a post-build checksum commit or moving a published tag.

CI checks committed binding freshness without running the generator and explicitly rejects tracked `.a`, `.so`, and `.dylib` files in the Go tree. Ignoring native binaries is not enough to catch accidental force-adds.

**3. How Go consumers obtain the generated source**

`go get` resolves modules through proxies or source control; a repository link cannot make it import a release attachment. `go generate` is not run automatically by `go get` or `go build`. See the [Go module reference](https://go.dev/ref/mod#goproxy-protocol) and [Go generation documentation](https://go.dev/blog/generate).

Recommend the proposed module path **`go.wasmer.io/sdk`**, subject to confirming domain routing and hosting ownership. Its discovery response identifies a module proxy. That endpoint serves version listings and maps `.info`, `.mod`, and `.zip` requests to the corresponding immutable GitHub release assets. Go's protocol supports redirects and `go-import` discovery with the `mod` scheme. Keep the module ZIP identical across operating systems and within Go's 500 MiB compressed/uncompressed limits. [Protocol and archive requirements](https://go.dev/ref/mod)

The native libraries stay outside the source module. Existing local archives are already large enough that bundling every platform into one module would be a poor default; measure final stripped release sizes during the spike.

The proxy is a small routing/index service, not a separate store of generated code. Cache immutable version responses, retain older versions, and expose only fully published Go releases. Unknown versions return 404; operational failures return 5xx. Validate downloads through the public Go proxy and checksum database before advertising the normal installation command. Consumers should not need global `GOPROXY` changes or disabled checksum verification. Domain/hosting access is an implementation dependency, not an assumption that the endpoint already exists.

Implement this service in **Node.js with zero npm dependencies**, using `node:http`, `URL`, and `node:fs/promises`. Proposed location: `go/proxy/server.mjs`, with protocol tests using `node:test`. Pin a supported Node release, initially Node 24, and put HTTPS termination at the hosting layer. Node supplies the required [HTTP server API](https://nodejs.org/api/http.html).

| Request on `go.wasmer.io` | Response |
| --- | --- |
| `/sdk?go-get=1` and discovery under `/sdk/` | Minimal discovery document identifying module `go.wasmer.io/sdk` and proxy base `https://go.wasmer.io/mod` |
| `/mod/go.wasmer.io/sdk/@v/list` | Published module versions, one per line |
| `/mod/go.wasmer.io/sdk/@latest` | Version/time metadata for the index's explicit latest release |
| `/mod/go.wasmer.io/sdk/@v/v0.1.0.info` | Redirect to the release's `v0.1.0.info` |
| `/mod/go.wasmer.io/sdk/@v/v0.1.0.mod` | Redirect to the release's `v0.1.0.mod` |
| `/mod/go.wasmer.io/sdk/@v/v0.1.0.zip` | Redirect to the release's `v0.1.0.zip` |

Use a small `versions.json` deployment input containing published versions, immutable asset URLs, version times, and the latest stable version. After publication verifies all assets, the release workflow atomically updates this index and activates it at the proxy. Preserve every older version and make retries idempotent. The index is ordinary metadata; it may be versioned in Git or delivered by the hosting platform without storing native binaries there. The service serves only this approved index, so no GitHub API query or database is needed on the request path. Missing/corrupt index state fails as a service error rather than pretending that all versions are absent.

Redirect to stable public GitHub release download URLs, not their temporary signed storage URLs. GitHub serves the archive bytes, keeping proxy memory and bandwidth small. Restrict routes to this module and published versions; return plain-text 404s for unknown modules/versions and 405 for unsupported methods. Cache discovery/list/latest briefly and versioned asset redirects for longer. Supporting this release-only module does not require a general-purpose proxy, branch/pseudo-version resolution, or a checksum-database proxy. Tests should cover discovery, exact redirects, version listing/latest, unknown paths, invalid versions, and failure states, followed by a real Go download against staged artifacts.

Proposed consumer flow; these commands do not exist yet:

```sh
go get go.wasmer.io/sdk@v0.1.0
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 install
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 exec -- go test ./...
go run go.wasmer.io/sdk/cmd/wasmer-sdk@v0.1.0 exec -- go build ./...
```

The helper reads the SDK version selected in the consumer's module graph, selects the target archive, verifies it against the native manifest from that version's source module, and installs it into a versioned user cache outside `GOMODCACHE`. Reject a helper/module/native-version mismatch. The `exec` command sets the required cgo environment for its child process; provide an `env` command for IDEs and existing build systems. Installation is explicit; ordinary builds do not unexpectedly fetch native code. Cached builds work offline. Allow a cache directory override and predownloaded archives for CI.

If we choose **no hosted proxy**, the same source ZIP and native archives could use a repository-provided downloader. It would unpack into an ignored project directory and print the required `go mod edit -require` and `-replace` commands. Every application/CI environment would need to bootstrap it; dependency-module replacements do not propagate to consumers. The implementation keeps the chosen proxy and publishes the complete source module with embedded native checksums.

**4. Native linking and supported targets**

Require `CGO_ENABLED=1` and a C toolchain for SDK consumers. Rust and UniFFI are maintainer build dependencies only. Native cross-compilation additionally requires a target C toolchain and matching archive; downloading another architecture alone is insufficient. [cgo documentation](https://pkg.go.dev/cmd/cgo)

Start with the four existing Python release targets and their backend selection:

| Go target | Rust target | Backend |
| --- | --- | --- |
| `linux/amd64` | `x86_64-unknown-linux-gnu` | `napi-v8` |
| `linux/arm64` | `aarch64-unknown-linux-gnu` | `sys` |
| `darwin/amd64` | `x86_64-apple-darwin` | `sys` |
| `darwin/arm64` | `aarch64-apple-darwin` | `napi-v8` |

Record and document this capability difference, including N-API-dependent Edge.js support. Verify both link modes for every target; do not silently omit a static archive if V8 linking proves difficult. Windows, musl/Alpine, mobile, and pure-Go builds are outside the first release matrix.

- **Default: static SDK linkage.** Have the helper select the archive explicitly and apply target-specific system libraries/frameworks, derived from Rust's native link requirements and validated by a standalone Go executable. Keeping static and dynamic libraries in separate directories prevents accidental shared-library selection. Static SDK linkage does not promise a fully static libc/C++ executable.
- **Optional: dynamic SDK linkage.** `exec --link dynamic` selects the shared library and development loader environment. Document deployment with the library alongside the executable, relocatable Linux/macOS loader paths, and dependent libraries. Test the deployed layout after removing the build cache; never rely on CI's absolute paths.
- Audit `.so`/`.dylib` dependencies and deployment targets. Python's wheel repair does not repair a Go archive. Build against a declared Linux baseline and verify the oldest supported runtime; align macOS with the established native minimum where dependencies permit.

**5. Public Go API and lifetime behavior**

Keep generated bindings under an internal package. Expose a small handwritten `wasmer` package matching the SDK's existing package → sandbox → command → process model. Preserve filesystem, ports, output limits, networking options, and checked run versus unchecked wait semantics. Return Go errors retaining the SDK error code; wrap streams as `io.Reader`/`io.WriteCloser` where appropriate.

Rust async methods become ordinary blocking Go methods usable concurrently from goroutines. The current [generator's async helper](https://github.com/NordSecurity/uniffi-bindgen-go/blob/0b7fb4ceef12021bd7f790cc516fa9133e001813/bindgen/templates/Async.go) polls futures and waits on a channel; it has no `context.Context` cancellation path. Initially preserve explicit run timeouts, process terminate/kill, and close operations. Do not claim general context cancellation by merely abandoning a goroutine. Add it only after proving future cancellation, underlying Tokio task/process cleanup, and callback-handle lifetime; the facade currently spawns work into its runtime.

Specify and test deterministic, idempotent `Close`, generated object destruction, parent/child ownership, and concurrent close versus active calls. Garbage-collection finalizers are a fallback, not the resource-management contract. The wrapper must prevent use-after-close and avoid freeing a future or callback while Rust can still call it.

**6. Release integration**

Extend the existing publication path rather than introducing Swift-style preparation commits:

1. Add Go to `release-please-config.json`, `.release-please-manifest.json`, and `.github/release-please/go.json`, using the simple release strategy and `go/version.txt`. Update branch/tag selection and explicit release-PR CI dispatch in `release.yml`.
2. Add Go build/test jobs to `ci.yml` and a four-target Go matrix to `build-release.yml`; update the bundle job's dependencies and success conditions. Pin the Rust, Go, and generator toolchains. Validate the minimum Go version and current supported releases before declaring compatibility.
3. After the Go release PR merges, build from its exact tagged commit. Build native archives, test their link modes, and calculate their hashes first.
4. Assemble the complete module from committed bindings, adding an embedded manifest of those native hashes. Package its ZIP, `.mod`, and `.info`, then test consumers against these exact staged bytes through a temporary module proxy.
5. Extend `sdk_release.py` and `github_release.py` component validation, version handling, asset allowlists, and metadata verification. Require three module assets plus exactly four target archives; inspect contents and architectures, not only filenames. Seal all assets with source identity and hashes.
6. Upload to the draft Go release and publish only after validation. Activate the module proxy's version index after the complete release is public. There is no npm/PyPI publish step for Go.
7. Retry proxy activation or publication using the original assets. Preserve the existing refusal to overwrite assets with different bytes. Never regenerate a module ZIP already visible to a Go proxy/checksum database; changed content needs a new version.

The embedded native manifest excludes the source ZIP's own checksum, avoiding a hash cycle. `release-metadata.json` and `SHA256SUMS` cover the final assets. Account for shared Rust/UniFFI changes when deciding a Go version bump; a path-only Go release trigger can miss them.

**7. Acceptance checks and implementation sequence**

Deliver in reviewable stages:

1. **Compatibility spike:** pinned 0.32-capable generator, one real SDK consumer, both link modes, async/error/ownership checks, and a recorded decision on the generator revision. Stop expanding implementation if this foundation fails.
2. **Go SDK:** explicit bindings generation, committed Go/C output, public wrapper, examples, local build tooling, and contract tests using existing fixtures. Native outputs remain ignored.
3. **Release archives and installer:** four platforms, dependency audits, deterministic source packaging, version/hash checks, and a pure-Go helper. Exercise a fresh external consumer with Rust absent from PATH and an empty native cache.
4. **Publication and discovery:** release-please/workflow integration, hosted proxy/discovery, and public module resolution. If the archive-only option is selected, replace the proxy work with the documented local-module bootstrap.

Release acceptance includes local Wasm execution, package creation, registry loading, streams/EOF, filesystem and ports, timeout/kill, repeated cleanup, and concurrency/race checks. Run existing Python and Swift checks if shared facade/configuration changes. Include pinned real Python/PostgreSQL workloads and Edge.js on N-API targets, using the repository's existing fixtures.

Distribution tests must cover static and dynamic consumers on every advertised target, a moved dynamic deployment, tampered and mismatched archives, interrupted installation, offline reuse, and clean module/native caches. Verify runtime compatibility on the declared OS baseline. Go's race detector helps test Go synchronization but does not by itself prove Rust/FFI memory safety.

**Review decisions**

The selected approach uses a tested and pinned UniFFI 0.32 generator port, committed Go/C bindings, independent Go `0.1.0` releases, `go.wasmer.io/sdk` through a release-backed proxy, a separate native installer, static SDK linkage by default with dynamic linkage available, and the four-platform backend matrix above. Static/dynamic native libraries remain in Go releases and out of Git.
