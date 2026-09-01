# Releasing the SDK

Release Please owns independent Python and JavaScript versions. Python uses
`v<version>` tags and JavaScript uses `wasmer-sdk-js-v<version>` tags so the
two release lines cannot collide. The Rust and UniFFI crates remain workspace
inputs and are not published by this workflow.

The Python package is `wasmer-sdk`, with its version in
`python/pyproject.toml`. The JavaScript package is `@wasmer/sdk`, with its
version in `js/package.json`; this repository takes over that existing npm
package at `0.11.0`. `.release-please-manifest.json` records the independently
accepted versions for both package paths.

To start a release, open **Actions → Release Python → Run workflow** and leave the version at `0.1.0` for the first run. The manual run creates or updates the Release Please PR. Review and merge that PR; its `autorelease: pending` label causes the same workflow to create `v0.1.0` and the GitHub release, then build and test the Python wheels before publishing them to PyPI. Later manual runs can provide the next version in the workflow input.

The wheel matrix produces Linux arm64, Linux x86-64, macOS arm64, and macOS x86-64 artifacts. Each wheel is tagged for Python 3 rather than a particular CPython ABI because the package loads its UniFFI native library through `ctypes`; the wheel is platform-specific but Python-version-independent.

PyPI publication uses trusted publishing. Register repository `wasmerio/wasmer-sdk`, workflow filename `release.yml`, environment `pypi`, and package `wasmer-sdk` in PyPI. The publish job requests `id-token: write` only in that environment and does not use a long-lived PyPI token.

npm publication also uses trusted publishing. Configure `@wasmer/sdk` for the
GitHub repository `wasmerio/wasmer-sdk`, workflow `publish-npm.yml`, environment
`npm`, and the `npm publish` permission. A successful publication automatically
updates wasmer-sh to the exact published version and regenerates its npm and
pnpm lockfiles.

The workspace resolves Wasmer crates from the `sdk` branch of `wasmerio/wasmer`, with `Cargo.lock` pinning the exact commit compiled into each wheel. Moving that branch does not alter an existing locked build; update the lockfile intentionally when adopting a newer runtime revision.
