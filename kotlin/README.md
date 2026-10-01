# Wasmer SDK for Kotlin

Kotlin/JVM and Android bindings to the same Rust/UniFFI SDK used by Swift and
Python. Android executes Wasm natively with Cranelift. The ARM64 build also embeds
V8 for Edge.js / Node-API. Kotlin callers use suspending functions and byte flows:
`Wasmer → packages / sandboxes → command → run / spawn`.

The Android library supports API 28+. The full runtime targets `arm64-v8a`;
`x86_64` is available without Node-API for emulator testing. JVM development is
supported on macOS and Linux. These are source builds and local Maven artifacts;
there is no published Maven Central release yet.

## Build

Install Rust **1.95+**, JDK **17**, and Python **3.9+**. Gradle is supplied by the
checked-in wrapper with a pinned distribution checksum. From the repository root:

```sh
python3 kotlin/scripts/build.py
kotlin/gradlew -p kotlin -Pandroid=false :sdk:test
kotlin/gradlew -p kotlin -Pandroid=false :examples:run --args=python
```

The JVM library uses `target/debug/libwasmer_sdk_uniffi.{so,dylib}`. For another
application set `-Djna.library.path=/absolute/path/to/the/native/library/directory`.
The host development build uses Cranelift without Node-API, like the native Swift
development build.

For Android, install these SDK packages and set `ANDROID_HOME`:

```sh
sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'ndk;28.2.13676358'
python3 kotlin/scripts/build.py --android
kotlin/gradlew -p kotlin :android:assembleRelease
```

Use `--release` for optimized Android Rust libraries. Without it the development
build is larger and guest compilation is slower. The AAR is written to
`kotlin/android/build/outputs/aar/android-release.aar`. It contains the native SDK,
libc++, Kotlin facade and Android TLS helper; its Gradle dependencies supply JNA,
coroutines and Android Startup. The native libraries use 16 KiB ELF alignment.

Use `implementation(project(":android"))` from an app in this Gradle build, or
publish the AAR and dependency metadata to your local Maven repository:

```sh
kotlin/gradlew -p kotlin :android:publishReleasePublicationToMavenLocal
# Consumer: repositories { mavenLocal(); google(); mavenCentral() }
# dependencies { implementation("io.wasmer:wasmer-sdk-android:0.1.0-SNAPSHOT") }
```

JVM consumers use the `:sdk` module (`wasmer-sdk-jvm`). Do not include both the JVM
and Android artifacts in one application: they contain the same API classes.

## Run a package

```kotlin
import io.wasmer.sdk.*
import kotlin.time.Duration.Companion.seconds

// In a coroutine. Android Startup initializes certificate verification.
Wasmer.create(context).use { wasmer ->
    wasmer.sandboxes.create(
        packages = listOf(PackageSource.Registry("python/python@=3.13.20")),
        files = mapOf("main.py" to "print('Hello from Kotlin!')".encodeToByteArray()),
    ).use { sandbox ->
        val output = sandbox.command("python", listOf("/workspace/main.py"))
            .run(timeout = 30.seconds)
        println(output.text())
    }
}
```

`Wasmer.create(context)` uses the app's cache directory. On the JVM use `Wasmer()`
or `Wasmer(cacheDirectory = File(...))`. Close sandboxes before closing the client.
The suspending `use` helpers perform cleanup in `NonCancellable`.

Packages can come from registry strings, local directories / WEBC files, Wasm or
WEBC bytes, reusable `Package` objects, or typed `PackageDefinition` values. Raw
Wasm must export `_start` and receives a command named `main`. `loadMany()` reports
download progress and cancels downloads when its coroutine is cancelled. Progress
callbacks run on native threads: dispatch UI changes to `Dispatchers.Main`.

`run()` checks exit status by default. `ProcessExitException.output` retains both
streams, the exit code, reason and truncation flags. Use `run(check = false)` to
inspect failures directly. `wait()` defaults to unchecked. `output.text()` checks
success and rejects invalid UTF-8; raw byte arrays are always available.

## Live processes and files

```kotlin
val process = sandbox.command("python", listOf("-u", "-c", "print(input())"))
    .spawn(stdin = Input.PIPE, timeout = 30.seconds)
coroutineScope {
    val out = launch { process.stdout!!.chunks().collect { System.out.write(it) } }
    val err = launch { process.stderr!!.chunks().collect { System.err.write(it) } }
    process.stdin!!.write("Hello\n")
    process.stdin!!.close()
    process.wait(check = true)
    out.join()
    err.join()
}
sandbox.fs.writeText("nested/message.txt", "Hello 🦀")
println(sandbox.fs.readText("nested/message.txt"))
```

Chunks can split UTF-8 characters. Each stream permits one active reader; drain
stdout and stderr concurrently, or select `CAPTURE` / `DISCARD` for unread streams.
Coroutine cancellation by itself does not guarantee that guest execution stops.
Use `kill()`, `terminate()`, command timeouts, or sandbox closure to bound execution.

`spawn(terminal = TerminalOptions(80, 24))` attaches WASIX line discipline and
pipes all three streams. `process.resizeTerminal(100, 30)` updates dimensions;
the underlying SDK currently does not deliver SIGWINCH. Commands accept a string,
a package entrypoint, or `package.command(name)`.

Workspace storage is currently in memory, matching the native Swift facade.
It survives commands within a sandbox, and is discarded when that sandbox closes.
Android native-directory mounts and iOS's OPFS storage are not exposed in this
Kotlin version. Networking defaults to `DISABLED`; `HOST` grants the guest the
app's host-network access. `sandbox.ports.wait(port)` waits for a local listener.
Automatic listener discovery and authenticated iOS preview proxies are not
part of the native backend. Inspect `wasmer.capabilities` for optional features.

## Examples and Wasmer Shell

The JVM examples support `python`, `stream`, `files`, and `wasm <path>`:

```sh
kotlin/gradlew -p kotlin -Pandroid=false :examples:run --args=stream
kotlin/gradlew -p kotlin -Pandroid=false :examples:run --args=files
kotlin/gradlew -p kotlin -Pandroid=false :examples:run --args='wasm /absolute/path/program.wasm'
```

[Wasmer Shell](shell/README.md) is the native Android app. It shares the iOS
libghostty-vt bridge, dark palette, example catalog, Bash prompt, terminal controls,
and server-preview layout. Its template sources come from `wasmer-sh/workspace`.

## Android tests

Connect a device or start an Android 28+ emulator. For the full suite use an ARM64
Android 15 emulator or ARM64 device. Install Zig **0.16.0** to build Ghostty:

```sh
python3 kotlin/scripts/android.py test
python3 kotlin/scripts/android.py test --integration --skip-native
```

The default suite runs the same eight offline SDK contract tests as the JVM,
plus certificate rejection checks and real Ghostty Unicode/ANSI rendering and
keyboard tests. The integration
suite additionally downloads packages and drives Python, Node.js and Clang inside
the app's real Bash terminal, opens a Python HTTP server in the preview, and checks
Ctrl-C and clean session shutdown, with deadlines.

On an x86_64 emulator:

```sh
python3 kotlin/scripts/android.py test --abi x86_64
```

That build disables Node-API because the pinned V8 distribution has no Android
x86_64 archive. The library reports `capabilities.nodeApi == false`. Registry
integration tests require the ARM64 build. Test reports are under each module's
`build/reports/androidTests/connected/debug` directory. CI builds an ARM64 AAR/APK
and runs the offline suites on an x86_64 emulator.

## Generated bindings and dependencies

`sdk/src/main/kotlin/io/wasmer/sdk/ffi/wasmer_sdk_uniffi.kt` is generated and checked
in. Regenerate it with `scripts/build.py` whenever the UniFFI interface changes.
UniFFI's ABI checks remain enabled. Kotlin-only renames in
[`rust/uniffi/uniffi.toml`](../rust/uniffi/uniffi.toml) avoid collisions with
`AutoCloseable.close` and `Throwable.message`; other SDKs retain their names.

The Android library initializes `rustls-platform-verifier` with the application
context through a small JNI entrypoint and bundles the matching Kotlin verifier.
The [vendored helper](android/vendor/rustls-platform-verifier/README.md) includes
a compatibility fix for public certificates without OCSP responders; certificate
chain, hostname and stapled-response validation remain enabled. Registry
downloads use Android's trust store.
The build links Android's compiler builtins explicitly and adapts the pinned
Wasmer Node-API build's Linux linker flags to Bionic/libc++. It does not modify
Cargo's dependency sources. Ghostty is pinned to the same revision as iOS and
receives a build-only adjustment to keep its host generators separate from the
NDK target's libc configuration.
Android builds with Node-API disable WASIX asynchronous threading for the whole
command tree, including Bash children, because V8 cannot unwind those coroutine
stacks. Guest execution still runs outside Android's UI thread.

See [UniFFI's Kotlin guide](https://mozilla.github.io/uniffi-rs/latest/kotlin/gradle.html)
and [Android native page-size guidance](https://developer.android.com/guide/practices/page-sizes).
