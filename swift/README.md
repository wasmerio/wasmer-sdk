# Wasmer SDK for Swift

One SwiftPM product, **`WasmerSDK`**, provides the same Swift API on both platforms:

| Platform | Internal backend |
| --- | --- |
| macOS 12+ | Native Wasmer with UniFFI |
| iOS 27+ | WASIX in a hidden, unattached WKWebView with JSPI |

Both use `import WasmerSDK` and the same `Wasmer → packages / sandboxes → command → run / spawn`
model as the Rust, Python, and JavaScript SDKs. Package definitions, raw Wasm and
WEBC bytes, registry packages, command references, captured output, live streams,
exit checking, timeouts, files, and sandbox lifetime share one facade. Applications
do not create or attach a runtime WebView, and SDK calls are not main-actor-only.

The iOS backend is experimental. CI packages its JS/Wasm resources in a separate
`WasmerWKRuntime` XCFramework, downloaded and embedded by SwiftPM in releases;
consumers need neither Node nor Rust. See [iOS setup](WasmerWKSDK/README.md).
The existing `wasmer-sdk-swift-v0.2.1` release predates iOS support. Until the next
Swift release, build the runtime locally using the iOS guide.

Optional features have explicit capability flags and throw `CAPABILITY_UNAVAILABLE`
when unsupported by the selected backend:

| Capability | macOS native binding | iOS WebKit binding |
| --- | --- | --- |
| Local package directories | Yes | Use a package definition or WEBC instead |
| Workspace storage | Memory | Memory, Native, OPFS |
| App directory mounts | Not yet exposed | `DirectoryMount` |
| Terminal / resize | Not yet exposed | `TerminalOptions`, `resizeTerminal` |
| HTTP discovery / exposure | Not yet exposed | `ports.listening()`, `ports.expose()` |

Inspect `wasmer.capabilities` when using these optional features. `.host` networking
uses the native runtime on macOS and native DNS/TCP on iOS; iOS does not support UDP
or arbitrary inbound native sockets. The Swift surface is shared; backend capabilities
and platform restrictions are not identical.

[WasmerShell](Examples/WasmerShell) uses only the public SDK API for its native
libghostty-vt terminal, Bash, Node.js via Edge.js, Python, cowsay, and `pnpm i react`.
Guest HTTP servers open in a separate browser view. The iOS implementation has been
tested in the simulator and cross-compiled for devices; physical-device testing remains.

## Workspace storage

On iOS, choose the storage backend when creating a sandbox:

```swift
let sandbox = try await wasmer.sandboxes.create(
    packages: [.package(python)],
    storage: .opfs("MyWorkspace") // or .native(directoryURL), or .memory
)
try await sandbox.fs.writeText("hello.txt", "Hello")
// Guest commands see the same file at /workspace/hello.txt.
```

`.memory` is the default on both platforms and lasts for the sandbox's lifetime.
Native and OPFS workspace selection are currently iOS capabilities; macOS rejects
these options with `CAPABILITY_UNAVAILABLE`. All use the same `sandbox.fs` API.
Native storage uses an app-accessible directory. OPFS volumes are named, persist
across launches, and allow one open sandbox per volume. Use different volume names
for concurrent sandboxes. OPFS is managed by WebKit, subject to its storage quota;
use native storage when files must be accessible directly through Foundation.

Next.js installation and execution use the default 192 MiB guest memory limit
in the same runtime. For development, `Wasmer(guestMemoryLimitBytes: ...)`
accepts overrides of 64–512 MiB in multiples of 64 KiB on iOS. Larger limits
can exhaust WebKit memory; native macOS rejects overrides.

## Install a binary release

Swift releases use `wasmer-sdk-swift-v<version>` tags and attach a universal
macOS XCFramework containing both Apple Silicon and Intel binaries. The first
configured Swift release is `0.2.1`. Once that release is published, add:

```swift
dependencies: [
    .package(
        url: "https://github.com/wasmerio/wasmer-sdk.git",
        revision: "wasmer-sdk-swift-v0.2.1"
    ),
]
// In your target's dependencies:
.product(name: "WasmerSDK", package: "wasmer-sdk")
```

Use `revision:` for these component-prefixed tags; SwiftPM's `from:` and
`exact:` semantic-version selection do not recognize that prefix. In Xcode,
add the repository URL and select the component tag as a revision. Applications
that require strict commit pinning can use the release tag's commit SHA instead.

The repository's root `Package.swift` at the release tag contains the archive's
GitHub release URL and SHA-256 checksum. SwiftPM downloads the prebuilt Rust
library and compiles the included Swift bindings; consumers do not need Rust,
UniFFI, or a separate binary repository. The ZIP is also available directly on
the [Swift release](https://github.com/wasmerio/wasmer-sdk/releases/tag/wasmer-sdk-swift-v0.2.1).
See [release automation](../docs/releases.md) for preparation and publication.

## Load or create a package from Wasm

Load a single raw WASI/WASIX module with
`let package = try await wasmer.packages.load(wasmData)`.
The `Data` can contain Wasm or WEBC, detected by its contents. A raw module must
export `_start` and gets one command and entrypoint named `main` automatically.
Run it with `sandbox.command(package)` or `sandbox.command("main")`. WEBC
packages retain their declared commands and entrypoint.

Use a typed definition to execute a raw WASI/WASIX module on macOS:

```swift
let definition = PackageDefinition(
  modules: ["app": wasmData],
  commands: ["hello": PackageCommandDefinition(module: "app")],
  files: ["/data/config.json": Data("{}".utf8)]
)
let package = try await wasmer.packages.create(definition)
let sandbox = try await wasmer.sandboxes.create(packages: [.package(package)])
let output = try await sandbox.command(package, ["--help"]).run()
print(try output.text())
try await sandbox.close()
```

`wasmData` is `Data`, for example from `Data(contentsOf: fileURL)`. No WEBC
archive is generated. Command modules must export `_start`; a sole command is
the inferred entrypoint. For multiple commands, set `entrypoint: "hello"` or
select a named command. Bundled files use canonical absolute guest paths and
private execution overlays; the sandbox workspace holds persistent data. A
created package can also be installed with `.package(package)` in an existing
sandbox. Close the client when finished.

## Build and use locally

Install Rust 1.95 or newer, Swift 6, and Xcode on macOS. Building the library
only requires Apple's Command Line Tools; running the tests requires full Xcode.
From the repository root:

```console
python3 swift/scripts/build.py
python3 swift/scripts/test.py
swift run --package-path swift WasmerDemo
```

Use `--release` for an optimized Rust library. The script generates
`Sources/WasmerSDKCore/WasmerSDKCore.swift` and
`Artifacts/WasmerSDKFFI.xcframework` together. Generated Swift is checked in;
the native archive is ignored by Git. Rebuild
after changing the Rust facade, UniFFI version, or Cargo lockfile. Generation
keeps UniFFI's ABI checksums enabled.

Add the `swift` directory as a **local package** in Xcode, then link the
`WasmerSDK` product. For another Swift package:

```swift
dependencies: [.package(path: "../wasmer-sdk/swift")]
// In your target's dependencies:
.product(name: "WasmerSDK", package: "swift")
```

The default XCFramework contains the host macOS architecture. For a universal
macOS build, install both Rust targets and request both:

```console
rustup target add aarch64-apple-darwin x86_64-apple-darwin
python3 swift/scripts/build.py --release \
  --target aarch64-apple-darwin --target x86_64-apple-darwin
```

The build deliberately disables the optional native V8/Node-API integration;
ordinary Wasm/WASI/WASIX packages use Cranelift. Use the `swift` subdirectory
package for development; the root package is the release distribution entry point.

`WasmerDemo` is a small SwiftUI app that runs Python off the main actor and
displays its output. The first run downloads the Python package from the registry.
Its [source](Examples/WasmerDemo/WasmerDemo.swift) can also be used in an Xcode
macOS app target linked to `WasmerSDK`.

To create a local `.app` bundle with Hardened Runtime enabled:

```console
python3 swift/scripts/build-demo.py
open swift/Artifacts/WasmerDemo.app
```

This uses ad hoc signing for local development. It is not a notarized release.

## Embedding in a macOS app

The pinned Cranelift runtime maps generated code without `MAP_JIT`. When your
app enables Hardened Runtime, it therefore needs
`com.apple.security.cs.allow-unsigned-executable-memory`; `allow-jit` alone
does not cover this allocator. The demo's
[entitlements](Examples/WasmerDemo.entitlements) enable that exception. See
Apple's [executable memory entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory).

For an Xcode app with App Sandbox enabled, also enable **Outgoing Connections
(Client)** to download registry packages or grant guests outbound host networking.
Guest listeners require **Incoming Connections (Server)**. Local package paths
must be readable within your app's sandbox; the default cache is placed in its
user Caches directory. The demo bundle uses Hardened Runtime without App Sandbox.

## Run a package

```swift
import Foundation
import WasmerSDK

let wasmer = try Wasmer()
let sandbox = try await wasmer.sandboxes.create(
    packages: ["python/python@=3.13.20"],
    files: ["main.py": Data("print('Hello from Swift')".utf8)]
)
do {
    let output = try await sandbox.command("python", ["/workspace/main.py"])
        .run(timeout: 30)
    print(try output.text())
} catch {
    try? await sandbox.close()
    try? await wasmer.close()
    throw error
}
try await sandbox.close()
try await wasmer.close()
```

The default cache lives in the application's user Caches directory. Pass
`Wasmer(cacheDirectory: fileURL)` to choose a writable location. Package
resolution may access the registry; guest networking defaults to `.disabled`.
Pass `network: .host` to grant native guest networking.

Load reusable packages through `wasmer.packages.load(...)`. Sources include a
registry string, `.file(URL)` for a local package directory or WEBC file,
`.bytes(Data)` for WEBC or raw Wasm, and `.package(Package)`. The `.webc(Data)`
spelling is retained for compatibility. Read a raw `.wasm` file into `Data`
before loading it.
`sandbox.installPackage(...)` accepts the same sources. Commands accept a name,
a loaded `Package` (its entrypoint), or a `CommandRef` from `package.command(...)`.

`run()` throws `ProcessExitError` for an unsuccessful exit, timeout, or
termination. Its `output` retains stdout, stderr, status, and truncation flags.
Use `run(check: false)` to inspect these directly. `output.text()` checks success
and requires valid UTF-8; raw output is always available as `Data`.

## Live processes and files

```swift
let process = try await sandbox.command("python", ["-u", "-c", "print(input())"])
    .spawn(stdin: .pipe, stderr: .discard, timeout: 30)
try await process.stdin?.write("Hello\n")
try await process.stdin?.close()
if let stdout = process.stdout {
    for try await chunk in stdout {
        // Chunks are bytes and can split a UTF-8 character; buffer before decoding.
        print(chunk)
    }
}
let output = try await process.wait(check: true)

try await sandbox.fs.writeText("nested/greeting.txt", "Hello")
let greeting = try await sandbox.fs.readText("nested/greeting.txt")
```

Streams pull data on demand and preserve backpressure. Use one reader per
stream and drain stdout and stderr concurrently if both are piped. Use
`.capture` or `.discard` for streams you do not read. `wait()` is unchecked by
default. `terminate(gracePeriod:)`, `kill()`, and `sandbox.close()` explicitly
control process lifetime.

Swift task cancellation alone does not guarantee termination of guest work:
the shared UniFFI facade launches tasks on Tokio. Use process termination or a
command timeout to bound execution. Close sandboxes before closing the client,
including on error paths. All wrapper values are `Sendable`, backed by the
shared Rust objects; copying a wrapper shares its underlying state.

## What remains for iOS

The workspace pins Wasmer to `f9b88e70b3822779ccb79d97134296b5120f3818`:

- Its native SDK selects Cranelift, which generates executable code at runtime.
- Its Wasmer API exposes `sys`, `v8`, and `js` backends; there is no Wasmi or WAMR
  backend in this revision.
- Its V8 build script has no iOS device or simulator target and does not select
  a Wasm interpreter. V8's [iOS build documentation](https://v8.dev/docs/cross-compile-ios)
  requires a JITless build.

Generating Swift bindings or cross-compiling a Cranelift archive does not
resolve those runtime constraints. The build script rejects iOS targets before
building, so it cannot accidentally produce a desktop/JIT artifact labeled as
iPhone-compatible. No iOS simulator or device execution is claimed.

To complete iOS support, first provide a compatible interpreter backend in the
pinned Wasmer/WASIX stack (or a supported signed static AOT execution path),
then select it through an independent Cargo feature. Add device
`aarch64-apple-ios` and simulator `aarch64-apple-ios-sim`/`x86_64-apple-ios`
libraries as separate XCFramework slices, declare the iOS deployment target in
`Package.swift`, and run the fixture suite on a simulator and a physical device.

## Tests and generated code

The tests use bundled local packages and do not require registry access.
With full Xcode, `swift test --package-path swift` works directly. The test
script selects `/Applications/Xcode.app` for this process when Command Line
Tools is the active developer directory. It does not change system settings;
set `DEVELOPER_DIR` explicitly to use another Xcode installation.
The fixtures exercise actual Swift → UniFFI → Rust → Wasm calls: captured output,
exit errors, stdin/streaming, timeout/termination, filesystem operations,
package selection/install, and invalid inputs.

To also download and run Python from the registry:

```console
WASMER_SWIFT_INTEGRATION=1 python3 swift/scripts/test.py --filter registryPython
```

After editing a fixture's `.wat`, regenerate the checked-in `.wasm` files:

```console
cargo run --locked -p wasmer-sdk-uniffi --no-default-features \
  --features sys --example swift_fixtures
```

UniFFI's Swift options live in [`../rust/uniffi/uniffi.toml`](../rust/uniffi/uniffi.toml);
see the [UniFFI Swift configuration guide](https://mozilla.github.io/uniffi-rs/latest/swift/configuration.html).
