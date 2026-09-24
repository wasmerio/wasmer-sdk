# SDK releases

JavaScript, Python, Swift, and Go retain independent versions and GitHub releases.
Release Please reads each component's manifest and creates separate release PRs.
Existing JavaScript and Python versions and tag names are preserved; Swift's
initial version is `0.2.1`, matching Python at the time Swift was added.

| Component | Version source | GitHub tag | Attached packages |
| --- | --- | --- | --- |
| JavaScript | `js/package.json` | `wasmer-sdk-js-v<version>` | One npm `.tgz`, including Node and browser exports |
| Python | `python/pyproject.toml` | `wasmer-sdk-python-v<version>` | Four `py3-none` wheels: macOS arm64/x86_64 and Linux aarch64/x86_64 |
| Swift | `swift/version.txt` | `wasmer-sdk-swift-v<version>` | One universal macOS arm64/x86_64 XCFramework ZIP |
| Go | `go/version.txt` | `wasmer-sdk-go-v<version>` | Source module ZIP, `.mod`/`.info`, and four native archives containing static and dynamic libraries |

Each release also includes `SHA256SUMS` and `release-metadata.json`, recording
the source commit, component version, and artifact hashes. Rust crate versions
remain independent internal workspace versions. iOS and Windows binaries are
not part of this matrix.

## Prepare and publish

1. Merging an ordinary PR into `main` runs **Release SDK** (`release.yml`).
   Release Please opens or updates component PRs from conventional commits.
   You can also run it manually on `main` with `tag` empty, including after
   direct pushes. Merging a component release PR follows the publication path
   in step 3 instead. Preparation uses the action's returned PRs immediately and
   also finds existing pending PRs for retries, so GitHub search indexing cannot
   omit a newly opened release. Pending JS/Python PRs get explicit CI runs because PRs created with
   `GITHUB_TOKEN` do not trigger another workflow automatically.
2. If a Swift PR exists, **Prepare Swift release** builds the native macOS
   XCFramework for both architectures and the WebKit runtime XCFramework from
   the JS/Rust sources. It tests the native archive on Apple Silicon and Intel,
   including a real registry package, and validates the WebKit archive through
   a SwiftPM consumer. Both are saved as Actions artifacts. It
   commits the generated bindings, binary URLs, checksums, and build receipt to
   the PR, then explicitly runs CI. Wait for preparation and CI before merging.
3. Merge the component PR. **Release SDK** validates the component, then uses
   its scoped Release Please configuration to create a draft GitHub release
   and tag at the merge commit. JS/Python build and test from that exact commit.
   Swift retrieves and verifies its already prepared archives before tagging.
4. The workflow validates the complete platform set, uploads all artifacts,
   and publishes the completed GitHub release. It will never replace an
   existing asset with different bytes.
5. Python publication downloads the GitHub release wheels and publishes them
   to PyPI. JavaScript dispatches **Publish JavaScript to npm**, which downloads
   and publishes the attached tarball, then opens the existing wasmer-sh update
   PR using the actual published version. SwiftPM consumes the Swift release
   archives directly.

The npm and PyPI trusted publisher workflow filenames remain `publish-npm.yml`
and `release.yml`, with environments `npm` and `pypi`. Keep their existing OIDC
publisher configuration. The repository must allow Actions to create PRs and
write release assets. Require the **Release metadata** check for Swift release
PRs, in addition to the normal CI checks.

Swift staging artifacts are retained for 90 days. If the Rust/Swift/JS/build inputs
change or staging expires, update the PR with `main` and run **Prepare Swift
release** again with its PR number before merging. Preparation can attach the
tested binaries after unrelated Python updates to the PR, but rejects changed
Swift build inputs and concurrent pushes. The release step refuses
to tag stale or missing Swift binaries. Published tags are never moved to add
checksums or generated source.

## Retry a failed publication

### Release PRs are missing after a merge

An older merged PR with `autorelease: pending` blocks Release Please from opening
new PRs for **every** component. The preparation workflow fails with links to
those PRs so the block cannot look like a successful run with nothing to release.

Inspect the failed component release and its preparation run first. If a tag or
release already exists, recover that exact release using the retry procedure
below. Never remove its pending marker merely to bypass a failed publication.

If an unpublished attempt is intentionally superseded by current `main`, first
confirm that its component tag and GitHub release do not exist. Replace its
`autorelease: pending` label with `autorelease: superseded`, then dispatch
**Release SDK** on `main` with `tag` empty. The new PR advances from the version
already recorded in the manifest and includes the outstanding changes. This
prepares release PRs; it does not publish the superseded version or fabricate its
tag. In particular, wait for Swift binary preparation and the **Release metadata**
check before merging the new Swift release PR.

### Retry publication of an existing release

For a build failure or a partially uploaded draft, rerun the failed jobs in the
original workflow run. Completed build jobs and their uploaded artifacts are
reused; do not rebuild a completed package just to retry registry publication.

Once the GitHub release has all its assets, run **Release SDK** with its full
component `tag`. This verifies and reuses those assets without rebuilding.
For npm alone, **Publish JavaScript to npm** accepts the same JS tag; its
`sync_only` option retries only the wasmer-sh update.

An existing registry artifact is skipped only when its registry hash matches
the GitHub release file. Different bytes fail the job. A partly successful PyPI
upload retries only the missing platform wheels. Do not replace published
assets or reuse a version for a changed build; prepare a new version instead.

## Using Swift externally

Use the repository root as the package URL and pin the Swift component tag:

```swift
.package(
    url: "https://github.com/wasmerio/wasmer-sdk.git",
    revision: "wasmer-sdk-swift-v0.2.1"
)
```

This becomes usable when the initial Swift release is published. Component
prefixes require SwiftPM's `revision:` form, not `from:` or `exact:` version
selection. A release tag's commit SHA can also be used. The release manifest
downloads the checksummed XCFramework automatically; only the Swift wrapper is
compiled on the consumer's machine. Swift 6 and macOS 12 or newer are required.
See [the Swift guide](../swift/README.md) for the API and application entitlements.

Use `swift/Package.swift` and `swift/scripts/build.py` for ongoing native source
development. The root manifest exposes the same `WasmerSDK` product for
iOS 27+, selecting the WebKit backend internally. CI generates its JavaScript/Wasm
resources and packages them in `WasmerWKRuntime-<version>.zip`, a dynamic XCFramework
for iOS devices, the simulator, and macOS. SwiftPM downloads the checksummed archive
and Xcode embeds the resources. Generated assets are not committed to git.
The Swift preparation job tests both archives and commits their URLs/checksums;
changes to JS inputs also invalidate that preparation. The existing 0.2.1 tag
predates iOS support; see the
[iOS installation guide](../swift/WasmerWKSDK/README.md#add-to-an-app) for
local build and resource generation instructions.

## Go distribution

Go's generated UniFFI bindings and C header are committed alongside the
handwritten API, helper, build tooling, and release descriptor. Normal CI and
release builds use these sources without compiling the binding generator.
`go/bindings.json` records their inputs and output hashes; CI checks this receipt
and requires explicit regeneration when it becomes stale. Native libraries
remain release-only artifacts, and CI rejects adding those binaries to Git.

The Go release matrix uses Linux amd64/arm64 and macOS amd64/arm64. It builds the
shared UniFFI facade, tests both link modes, runs registry workloads, and tests an
external application against the exact packaged module and native archive. The
bundle job requires all four architectures and matching interface hashes before
creating the complete source ZIP and embedded native checksums.

After GitHub publication, **Activate Go module proxy** verifies those assets and
updates `go/proxy/versions.json` on the `go-module-index` branch. This metadata
branch starts from the release source and updates only the index; it contains no
native binaries. The Node service reads the index and redirects module downloads
to immutable release assets.
If activation fails, dispatch that workflow again with the same Go component tag.

Before the first public Go installation, deploy the dependency-free
[Node proxy](../go/proxy/README.md), configure `go.wasmer.io` DNS/TLS, and verify
resolution through Go's default public proxy/checksum database. Version `v0.1.0`
is the Go module identity; `wasmer-sdk-go-v0.1.0` remains the repository release
tag. There is no registry upload to npm or PyPI for this component.

Changes to shared Rust/UniFFI inputs may need an explicit Go release bump even if
no file under `go/` changes. Check Go release scope during those reviews. Published
module ZIPs and native archives are never replaced with new bytes at the same
version. See the [Go guide](../go/README.md) for installation and source builds.

## Local validation

```console
python3.13 -m unittest discover -s .github/scripts/tests -v
actionlint
python3.13 .github/scripts/sdk_release.py check --component js
python3.13 .github/scripts/sdk_release.py check --component python
python3.13 .github/scripts/sdk_release.py check --component swift
python3.13 .github/scripts/sdk_release.py check --component go
python3.13 .github/scripts/go_release.py check
python3.13 go/scripts/bindings.py
node --test go/proxy/*.test.mjs
```

Release scripts use Python 3.11 or newer. Ordinary Python SDK consumers still
require only Python 3.9 or newer. Registry credentials are not needed for these
local checks, and they do not publish anything.
