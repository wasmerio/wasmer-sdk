# WasmerSDK on iOS

The public product and import are **`WasmerSDK`**, the same as macOS. This directory
contains its internal WebKit backend and integration probe. The separate local
package is for backend development, not the application-facing API.

Use Xcode 27+, Swift 6, and an **iOS 27.0** deployment target. The backend verifies
actual JSPI suspend/resume before starting WASIX. Its private `WKWebView` has a zero
frame, is hidden, and is never attached to a view or window. Public WebKit inactive
scheduling APIs allow detached execution; normal iOS app suspension still applies.

## Add to an app

In Xcode, add `https://github.com/wasmerio/wasmer-sdk.git` and select **WasmerSDK**.
The `wasmer-sdk-swift-v0.2.1` tag predates iOS support. Until a release includes this
change, select branch `codex/wasmer-shell-ios` (then `main` after merge), or pin its commit.

```swift
// Package.swift
platforms: [.iOS("27.0")],
dependencies: [
    .package(url: "https://github.com/wasmerio/wasmer-sdk.git",
             branch: "codex/wasmer-shell-ios"),
],
// Your target's dependencies:
.product(name: "WasmerSDK", package: "wasmer-sdk")
```

SwiftPM embeds the JS/Wasm resources automatically. No npm, Rust compilation, JIT
entitlement, Ghostty dependency, or manually copied assets are required. Only macOS
links the native UniFFI binary. Add this to the app's Info.plist for private loopback I/O:

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

Native directory access uses descriptor-relative `openat` with `O_NOFOLLOW` on every
component; symlinks are unsupported. Read-only mounts enforce permissions on both
sides. Worker filesystem RPC uses SharedArrayBuffer/Atomics, 64 KiB chunks, a 512 KiB
response limit, and a 30-second timeout. JSPI does not remove the isolation requirement.

The control server binds to `127.0.0.1`, uses a random URL token, and serves COOP/COEP.
Native package downloads are limited to content-addressed Wasmer CDN URLs, verify
SHA-256, and cache under the client's cache directory; downloads are capped at 128 MiB.

Each network-enabled sandbox has its own bridge. DNS and nonblocking TCP use native
APIs; TLS remains in the guest. Buffers are bounded to 1 MiB receive / 256 KiB send
per socket, native chunks are at most 64 KiB, and DNS/connect time out after 30 seconds.
UDP and native inbound listeners are unsupported. HTTP exposure supports bounded
request/response forwarding, not WebSocket upgrades or streaming responses.

Guest shared memories are capped at 128 MiB. The coordinator heap starts at 1.5625 MiB
and grows to at most 512 MiB; these are not total process-memory limits. The cap works
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

## Update bundled assets

Consumers do not run this. Maintainers changing Rust or JS SDK inputs regenerate:

```sh
npm ci --prefix js
python3 swift/WasmerWKSDK/scripts/prototype.py prepare --rebuild-wasm
python3 swift/WasmerWKSDK/scripts/bundle_sdk.py --check
```

`Web/sdk/manifest.json` records the source fingerprint and per-file SHA-256. CI rejects
stale assets. Swift release tags include these source resources alongside the checksum
pinned universal macOS XCFramework; the release process does not rebuild these assets.
