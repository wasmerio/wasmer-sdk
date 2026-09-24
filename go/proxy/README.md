# Go module endpoint

This Node.js 24+ service has no npm dependencies. GitHub Releases hold the Go
module ZIP, `.mod`, `.info`, and native archives. The service handles discovery,
version metadata, and redirects; it never regenerates or serves native binaries.

From the repository root (no dependency installation is needed):

```sh
npm --prefix go/proxy test
npm --prefix go/proxy start
```

Inside `go/proxy`, use `npm test` and `npm start` directly.

Deployment configuration:

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `8080` |
| `HOST` | `0.0.0.0` |
| `PUBLIC_ORIGIN` | `https://go.wasmer.io`; the public HTTPS origin |
| `MODULE_INDEX` | Local `versions.json`; updated by atomic replacement |
| `MODULE_INDEX_URL` | Optional remote index, cached for 60 seconds |

To follow automated releases, set `MODULE_INDEX_URL` to
`https://raw.githubusercontent.com/wasmerio/wasmer-sdk/go-module-index/go/proxy/versions.json`.
The release workflow activates a verified release by updating that metadata-only
file on `go-module-index`. Old entries cannot be overwritten by the updater.
The service keeps its last valid index during remote outages and rejects index
rollback or mutation while running; without a valid index it returns 503.
An empty local index serves an empty version list until a release exists.

Build a container with `docker build -t wasmer-go-proxy go/proxy`. Route
`go.wasmer.io` to port 8080 through an HTTPS terminator, preserving paths and
query parameters. Keep `/sdk?go-get=1`, nested `/sdk/` discovery requests, and
`/mod/go.wasmer.io/sdk/…` reachable publicly. No GitHub credentials are used by
the serving process. The publication workflow alone has repository write access.

`update-index.mjs INDEX METADATA INFO` updates a local index from verified release
metadata. `publish-index.mjs METADATA INFO` activates it on the GitHub index branch
and is intended for the serialized workflow. Both reject changing existing
version bytes. Re-running **Activate Go module proxy** with a component tag retries
index publication without rebuilding the SDK.

Before announcing the first release, configure DNS/TLS and check:

```sh
curl 'https://go.wasmer.io/sdk?go-get=1'
curl https://go.wasmer.io/mod/go.wasmer.io/sdk/@v/list
GOMODCACHE="$(mktemp -d)" go mod download go.wasmer.io/sdk@v0.1.0
```

The final check uses Go's default public proxy and checksum database. Do not
disable them for consumers. `go/scripts/test_release.py` uses a temporary local
proxy and disables the checksum database only for its unpublished test fixture.

Only canonical stable v0/v1 releases are supported. Unknown modules, branches,
pseudo-versions and unsupported major versions return 404. A future v2 requires
its own `/v2` module path and corresponding discovery/proxy configuration.
