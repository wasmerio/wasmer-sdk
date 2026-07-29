# Releasing the Python SDK

Only the Python distribution is released for now. Release Please owns its version, changelog, release PR, `v<version>` tag, and GitHub release. The Rust crates, UniFFI crate, and JavaScript package remain build-time inputs or separately tested surfaces; this workflow neither versions nor publishes them.

The public package is `wasmer-sdk`, and its version lives in `python/pyproject.toml`. The first release is `0.1.0`. `release-please-config.json` contains only the `python` package, while `.release-please-manifest.json` records versions accepted through Release Please. Keeping the package path explicit prevents changes to the Rust and JavaScript manifests.

To start a release, open **Actions → Release Python → Run workflow** and leave the version at `0.1.0` for the first run. The manual run creates or updates the Release Please PR. Review and merge that PR; its `autorelease: pending` label causes the same workflow to create `v0.1.0` and the GitHub release, then build and test the Python wheels before publishing them to PyPI. Later manual runs can provide the next version in the workflow input.

The wheel matrix currently produces Linux x86-64, macOS arm64, macOS x86-64, and Windows x86-64 artifacts. Each wheel is tagged for Python 3 rather than a particular CPython ABI because the package loads its UniFFI native library through `ctypes`; the wheel is platform-specific but Python-version-independent.

PyPI publication uses trusted publishing. Register repository `wasmerio/wasmer-sdk`, workflow filename `release.yml`, environment `pypi`, and package `wasmer-sdk` in PyPI. The publish job requests `id-token: write` only in that environment and does not use a long-lived PyPI token.

The workspace resolves Wasmer crates from the `sdk` branch of `wasmerio/wasmer`, with `Cargo.lock` pinning the exact commit compiled into each wheel. Moving that branch does not alter an existing locked build; update the lockfile intentionally when adopting a newer runtime revision.
