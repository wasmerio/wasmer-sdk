# SDK releases

JavaScript, Python, and Swift retain independent versions and GitHub releases.
Release Please reads each component's manifest and creates separate release PRs.
Existing JavaScript and Python versions and tag names are preserved; Swift's
initial version is `0.2.1`, matching Python at the time Swift was added.

| Component | Version source | GitHub tag | Attached packages |
| --- | --- | --- | --- |
| JavaScript | `js/package.json` | `wasmer-sdk-js-v<version>` | One npm `.tgz`, including Node and browser exports |
| Python | `python/pyproject.toml` | `wasmer-sdk-python-v<version>` | Four `py3-none` wheels: macOS arm64/x86_64 and Linux aarch64/x86_64 |
| Swift | `swift/version.txt` | `wasmer-sdk-swift-v<version>` | One universal macOS arm64/x86_64 XCFramework ZIP |

Each release also includes `SHA256SUMS` and `release-metadata.json`, recording
the source commit, component version, and artifact hashes. Rust crate versions
remain independent internal workspace versions. iOS and Windows binaries are
not part of this matrix.

## Prepare and publish

1. Merging an ordinary PR into `main` runs **Release SDK** (`release.yml`).
   Release Please opens or updates component PRs from conventional commits.
   You can also run it manually on `main` with `tag` empty, including after
   direct pushes. Merging a component release PR follows the publication path
   in step 3 instead. Pending JS/Python PRs get explicit CI runs because PRs created with
   `GITHUB_TOKEN` do not trigger another workflow automatically.
2. If a Swift PR exists, **Prepare Swift release** builds a release XCFramework
   for both architectures. It tests that archive on Apple Silicon and Intel,
   including a real registry package, and saves it as an Actions artifact. It
   commits the generated bindings, binary URL, checksum, and build receipt to
   the PR, then explicitly runs CI. Wait for preparation and CI before merging.
3. Merge the component PR. **Release SDK** validates the component, then uses
   its scoped Release Please configuration to create a draft GitHub release
   and tag at the merge commit. JS/Python build and test from that exact commit.
   Swift retrieves and verifies its already prepared archive before tagging.
4. The workflow validates the complete platform set, uploads all artifacts,
   and publishes the completed GitHub release. It will never replace an
   existing asset with different bytes.
5. Python publication downloads the GitHub release wheels and publishes them
   to PyPI. JavaScript dispatches **Publish JavaScript to npm**, which downloads
   and publishes the attached tarball, then opens the existing wasmer-sh update
   PR using the actual published version. SwiftPM consumes the Swift release
   archive directly.

The npm and PyPI trusted publisher workflow filenames remain `publish-npm.yml`
and `release.yml`, with environments `npm` and `pypi`. Keep their existing OIDC
publisher configuration. The repository must allow Actions to create PRs and
write release assets. Require the **Release metadata** check for Swift release
PRs, in addition to the normal CI checks.

Swift staging artifacts are retained for 90 days. If the Rust/Swift/build inputs
change or staging expires, update the PR with `main` and run **Prepare Swift
release** again with its PR number before merging. Preparation can attach the
tested binary after unrelated JS/Python updates to the PR, but rejects changed
Swift build inputs and concurrent pushes. The release step refuses
to tag stale or missing Swift binaries. Published tags are never moved to add
checksums or generated source.

## Retry a failed publication

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
development. The root manifest also exposes the `WasmerWKSDK` product for
iOS 27+. Its JavaScript/Wasm resources are versioned under `swift/WasmerWKSDK`
and need no native cross-compilation. The release manifest generator preserves
both products. The existing 0.2.1 tag predates the iOS product; see the
[iOS installation guide](../swift/WasmerWKSDK/README.md#add-to-an-ios-app) for
the prerelease revision and resource regeneration instructions.

## Local validation

```console
python3.13 -m unittest discover -s .github/scripts/tests -v
actionlint
python3.13 .github/scripts/sdk_release.py check --component js
python3.13 .github/scripts/sdk_release.py check --component python
python3.13 .github/scripts/sdk_release.py check --component swift
```

Release scripts use Python 3.11 or newer. Ordinary Python SDK consumers still
require only Python 3.9 or newer. Registry credentials are not needed for these
local checks, and they do not publish anything.
