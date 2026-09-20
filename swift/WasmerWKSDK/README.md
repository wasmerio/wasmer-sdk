# WasmerSDK on iOS

The public product and import are **`WasmerSDK`**, the same as macOS. This directory
contains its internal WebKit backend and integration probe. The separate local
package is for backend development, not the application-facing API.

Use Xcode 27+, Swift 6, and an **iOS 27.0** deployment target. The backend verifies
actual JSPI suspend/resume before starting WASIX. Its private `WKWebView` has a zero
frame, is hidden, and is never attached to a view or window. Public WebKit inactive
scheduling APIs allow detached execution; normal iOS app suspension still applies.

## Add to an app

For releases including iOS support, add `https://github.com/wasmerio/wasmer-sdk.git`
in Xcode, select the release tag as a revision, and choose **WasmerSDK**.
The `wasmer-sdk-swift-v0.2.1` tag predates iOS support. Until the next Swift release,
clone this repository, [build the runtime assets](#build-runtime-assets), and add
the repository root as a local package:

```swift
// Package.swift
platforms: [.iOS("27.0")],
dependencies: [
    .package(path: "../wasmer-sdk"),
],
// Your target's dependencies:
.product(name: "WasmerSDK", package: "wasmer-sdk")
```

Release consumers receive a checksummed `WasmerWKRuntime` XCFramework that SwiftPM
downloads and Xcode embeds, including its JS/Wasm resources. No npm, Rust compilation,
JIT entitlement, Ghostty dependency, or manually copied assets are required for those
releases. Only macOS links the native UniFFI binary. Add this to the app's Info.plist
for private loopback I/O:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

## Shared Swift API

This code works on iOS and macOS:

```swift
import Foundation
import WasmerSDK

let wasmer = try Wasmer()
do {
    let python = try await wasmer.packages.load("python/python@=3.13.20")
    let sandbox = try await wasmer.sandboxes.create(packages: [.package(python)])
    let output = try await sandbox.command("python", ["-c", "print(6 * 7)"]).run()
    print(try output.text())
    try await sandbox.close()
    try await wasmer.close()
} catch {
    try? await wasmer.close()
    throw error
}
```

The same facade covers package definitions, raw Wasm/WEBC, registry packages,
command selectors, reusable commands, captured output, piped streams, stdin,
exit checks, timeouts, termination, filesystem access, and multiple sandboxes.
SDK values are Sendable; the adapter dispatches WebKit work onto the main actor
internally. Guest computation and native I/O happen outside the main thread.

Optional capabilities are described in the [Swift guide](../README.md). On iOS,
mount app-accessible directories with `sandboxes.create(mounts:)`, enable outbound
DNS/TCP with `network: .host`, spawn a terminal using `TerminalOptions`, and forward
guest HTTP to a browser with `sandbox.ports.expose(port)`. Retain the returned
`ExposedPort`, use its `url`, and call `close()` when done. Closing the sandbox or
client also stops its preview listeners. Networking is disabled by default.

As in the Rust/JS SDK, `sandbox.fs` manages `/workspace`. Select its backing with
`storage: .memory` (default), `.native(directoryURL)`, or `.opfs("volume-name")`.
The same API reads and writes the selected backend; guest commands see those files. Directory
mounts are attached to guest processes; access them from guest code or through
the original native directory URL.

Swift task cancellation cancels the affected bridge request and terminates its
associated process where applicable. Other sandboxes keep running. Explicitly
close sandboxes and the client to release workers, native handles, and listeners.
Cancelled filesystem operations may already have taken effect.

## Architecture and limits

```text
Shared WasmerSDK Swift facade
  → internal WebKit adapter (packages, sandbox and process handles)
  → detached WKWebView control page
  → SDK coordinator worker → WASIX guest workers
  → native filesystem actor / native DNS and TCP
```

The RPC dispatcher calls the same Rust-generated core used by the JavaScript SDK.
The bridge uses structured messages with a fixed operation allowlist. Native messages
are accepted only from the main frame of the hidden runtime origin. Guest preview
pages use a separate loopback origin and data store, without native message handlers.

OPFS runs in a dedicated worker beside the SDK. File bytes use synchronous OPFS
handles; an append-only namespace journal preserves directory renames, while an
in-memory index serves metadata. Cached file handles are bounded. A named volume
has one writer, enforced by a Web Lock. Explicit flushes and periodic checkpoints
persist writes; normal shutdown flushes storage before terminating workers, with
a bounded deadline so Restart can recover from a wedged runtime. Abrupt termination
can lose writes since the last flush. Unlinked data files are reclaimed when the
volume reopens. The namespace journal currently grows until the volume is removed.

The hidden runtime uses a persistent WebKit data-store identifier and a stable
loopback port, saved in Application Support. Clients with the same cache location
share the asset server. If that saved port is unavailable, initialization fails
instead of changing the origin and appearing to lose OPFS files. Preview WebViews
remain separate and nonpersistent. OPFS uses WebKit quotas and is experimental.

Native directory access uses descriptor-relative `openat` with `O_NOFOLLOW` on every
component; symlinks are unsupported. Read-only mounts enforce permissions on both
sides. Worker filesystem RPC uses SharedArrayBuffer/Atomics, 64 KiB chunks, a 512 KiB
response limit, and a 30-second deadline. File bytes use base64 across the WebKit
native message boundary and raw bytes in the worker reply buffer, avoiding
per-byte JSON numbers. Metadata and errors retain structured JSON replies.
Inside Swift, typed Sendable filesystem requests and responses cross actors directly,
without additional JSON serialization.
JSPI does not remove the isolation requirement.

The control server binds to `127.0.0.1`, uses a random URL token, and serves COOP/COEP.
Native package downloads are limited to content-addressed Wasmer CDN URLs, verify
SHA-256, and cache under the client's cache directory; downloads are capped at 128 MiB.

Each network-enabled sandbox has its own bridge. DNS and nonblocking TCP use native
APIs; TLS remains in the guest. Buffers are bounded to 1 MiB receive / 256 KiB send
per socket, native chunks are at most 64 KiB, and DNS/connect time out after 30 seconds.
UDP and native inbound listeners are unsupported. HTTP exposure supports bounded
request/response forwarding, not WebSocket upgrades or streaming responses. It
allows 35 seconds to receive a request and 180 seconds for the guest response,
so development servers can compile their first page.

Guest shared memories are capped at 192 MiB.
Memory workspace files use the same shared in-memory filesystem as the browser
SDK. Guest filesystem operations stay inside Wasm without storage-worker RPCs;
file contents count toward the SDK heap limit. Native and OPFS store file
contents outside that heap.
Each WASIX thread runs in a dedicated Web Worker, which releases its SDK stack
and closes after the thread and its local asynchronous work finish. This lets
WebKit reclaim guest memories between commands. Host timers use a separate
worker and carry no guest-memory snapshots. Storage and the shell remain alive
across commands; users do not need to restart after installing dependencies.
The coordinator heap starts at 1.5625 MiB
and grows to at most 1 GiB; these are growth ceilings, not eager allocations or
total process-memory limits. The cap works
around WebKit shared-memory reservation failures, but does not update Wasmer's internal
MemoryType metadata. A production backend should expose these limits through Wasmer.

## Run and verify

```sh
python3 swift/WasmerWKSDK/scripts/prototype.py run --device <iOS-27-simulator-UDID>
python3 swift/Examples/WasmerShell/build.py test --device <iOS-27-simulator-UDID>
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path swift
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path swift/WasmerWKSDK
node --test swift/WasmerWKSDK/scripts/*.test.mjs
```

The probe executes the same contract checks as native Swift tests, then runs Python
twice after detached idle periods, checking threads, a child process, native text/binary
I/O, read-only rejection, changed native input, and an unattached runtime view.
Results are saved to `Artifacts/simulator-result.json`. WasmerShell checks the native
Ghostty terminal, Python, Node, DNS/HTTPS, `pnpm i react`, and isolated server previews.

Scripts default to `/Applications/Xcode.app`; set `DEVELOPER_DIR` to override. The
`build --platform device` command cross-compiles with ad hoc signing; use normal Xcode
development signing to install on a physical device. Device memory limits and sustained
execution still need physical-device testing before a production release.

## Build runtime assets

Generated JS/Wasm files are ignored by git. CI builds them from source for every PR
and Swift release. For local source development, install the JS build prerequisites
from [the JS guide](../../js/README.md), then run:

```sh
npm ci --prefix js
python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm
python3 swift/WasmerWKSDK/scripts/bundle_sdk.py --check
```

`Web/sdk/manifest.json` records the source fingerprint and per-file SHA-256.
`prototype.py` and the WasmerShell build script use these local assets and reject
stale builds. On a release checkout, set `WASMER_SDK_LOCAL_WEB_RUNTIME=1` when
building in Xcode or SwiftPM to select locally generated assets instead of the
released runtime; the example scripts set it automatically.

Swift release preparation builds `WasmerWKRuntime-<version>.zip` for iOS devices,
the simulator, and macOS; tests the archived framework through a clean SwiftPM
consumer; and pins its URL/checksum alongside the native macOS archive. Only the
manifest and checksums are committed. The generated runtime stays in CI artifacts
and GitHub release assets. To validate this packaging locally (Python 3.11+):

```sh
python3.13 swift/WasmerWKSDK/scripts/build_runtime.py
python3.13 swift/WasmerWKSDK/scripts/verify_runtime.py
```
