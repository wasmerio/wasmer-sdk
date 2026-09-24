# Wasmer Shell for Android

A native Kotlin app using the public Wasmer SDK and **libghostty-vt**. Wasm
executes on the device through UniFFI; Android Canvas draws Ghostty's terminal
cells. The WebView is used only to preview guest HTTP servers.

The app follows the iOS shell: a grouped example grid, Wasmer header, terminal,
restart / keyboard controls, Escape / Tab / arrows / Ctrl-C / Ctrl-D, and a local
browser preview. Example metadata and files are copied from `wasmer-sh` at build
time. The VT parser, color palette, Unicode handling and key encoding reuse
`swift/Examples/WasmerShell/GhosttyBridge.c` without a fork.

## Run

Follow the [Kotlin prerequisites](../README.md#build), install Zig **0.16.0** and
connect an ARM64 Android device or emulator:

```sh
python3 kotlin/scripts/android.py run
python3 kotlin/scripts/android.py run --example python --skip-native
python3 kotlin/scripts/android.py run --example node --skip-native
python3 kotlin/scripts/android.py run --example clang --skip-native
```

Use `--serial <adb-serial>` when more than one device is connected. Open the
`kotlin` directory in Android Studio to edit the SDK and app. The APK is
`shell/build/outputs/apk/debug/shell-debug.apk`; it uses local debug signing.
The helper builds optimized native libraries by default; `--debug-native` uses
an unoptimized Rust build when debugging the runtime.

Choose Python, Flask, Django, FastAPI, Node.js, Express, Next.js, Richards.js,
Clang / C, FFmpeg or yt-dlp. Each selected example receives its own in-memory
workspace and only the required packages plus Bash. The terminal shows the
installation and run commands. Dependencies are installed inside the guest using
pip or pnpm. **Open full shell** loads the catalog's available runtimes together.
The x86_64 build excludes Node-API; choosing a Node template explains the required
ARM64 build.

**Preview** opens a server by port (usually 8000 for Python or 3000 for Node).
The address field accepts paths such as `/health` or `/docs`. Navigation remains
on that loopback origin, and the preview has no native JavaScript bridge or file
access. **Terminal** returns to the running shell. Guest networking is native;
HTTP and WebSockets do not require the iOS HTTP forwarding bridge.

## Validation

```sh
python3 kotlin/scripts/android.py test --skip-native
python3 kotlin/scripts/android.py test --skip-native --integration
```

Tests exercise actual Wasm execution on Android and Ghostty's rendered cells.
The optional network suite opens three separate app sessions and executes Python,
Node and a C program compiled by Clang. It also starts Python's HTTP server and
opens the WebView preview. Registry/package availability affects
these tests. No physical-device execution is implied by an emulator pass.

## Current limits

This is a foreground application. Android may reclaim its process in the
background. Restarting or selecting a new template discards the workspace;
the shared package/compiled-code cache survives. Storage selection and automatic
guest-port discovery are not yet exposed by the native Kotlin SDK. Use the
Preview port control to open servers. The terminal supports basic IME composition
and scrollback, but not cell selection, copy, mouse reporting or per-cell
accessibility. Resizing updates the WASIX terminal dimensions without SIGWINCH.
Templates requiring an automatically managed background server, currently
PostgreSQL, are hidden from the Android catalog.

Ghostty revision `5de703a1b6ca0b91fcebe932b44be1df2de0a683` is MIT licensed;
the build includes `Ghostty-LICENSE.txt` in the APK assets. Kotlin and the SDK
use this repository's license. Native toolchain caches and build artifacts are
ignored by Git.
