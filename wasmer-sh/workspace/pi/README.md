# Pi in wasmer.sh

This is the full Pi 1.0.0 terminal coding agent, running inside the Wasmer
sandbox with Node.js, Bash, fd, ripgrep, grep, sed, and findutils.

```sh
pi
```

Pi 1.0 uses a fullscreen terminal interface by default. Run
`pi --tui-mode regular` to keep normal terminal scrollback.

Pi is already available from `wasmer/pi@=1.0.0` when the example opens. There is
no npm installation step. The package contains upstream Pi's unchanged runtime
files and CLI entrypoint, and depends on published `wasmer/edgejs@0.2.4` with
the native WASIX spawn and signal fixes.
The browser SDK needs the merged N-API module-loading changes and the Wasmer
filesystem timestamp fix for Pi's lock heartbeats. Edge's WASIX native binding
sets basic TCP keepalive and ignores unsupported timing options. The stock
WASIX libc and an ordinary WISP proxy work; no filesystem or networking preload
is needed. Runtime build instructions are in `packages/pi/README.md`.

No JavaScript preload is used. Edge's native WASIX bindings accept detached
spawning as ordinary child creation; WASIX does not create Unix process groups. Pi's cancellation falls back to terminating the immediate
child; use **Restart** to stop the sandbox and any remaining descendants.

Inside Pi, use `/login` to connect an AI provider with a subscription or API
key, then `/model` to choose a model. Existing Pi settings and provider
environment variables such as `ANTHROPIC_API_KEY` also work. Custom endpoints
can be configured in Pi's `models.json`.

Subscription OAuth flows that require opening a
host browser or receiving a localhost callback have not been verified here.
Configure the shell's WISP connection when prompted; model API requests use
that proxy. No provider credentials are bundled.

Try: **Read hello.js, add an optional greeting argument, and run it with node.**
Pi's default tools are read, write, edit, and Bash. To also expose its dedicated
search tools to the model:

```sh
pi --tools read,write,edit,bash,grep,find,ls
```

`fd --glob '*.js' .` and `rg 'greet' hello.js` execute real WASIX binaries. Pi
finds them on PATH, including for filename completion; it does not need to
download native executables. Use `/quit` to return to Bash.

Pi saves settings, credentials entered through `/login`, and sessions under
`/workspace/.pi/agent`.
The browser workspace is ephemeral: reloading, restarting, or selecting a new
example discards it. The shell caches runtime packages, not your Pi sessions.
Download files you want to keep before ending the workspace.

Pi resolves `wasmer/edgejs@0.2.4`, `wasmer/bash@1.0.25`, `wasmer/fd@10.5.1`,
`wasmer/ripgrep@15.2.1`, `wasmer/grep@3.12.0`, `wasmer/sed@4.9.0`,
`wasmer/findutils@0.10.1`, `wasmer/coreutils@1.0.27`, and `curl/curl@8.4.0`
as registry dependencies. Findutils supplies `find`, `xargs`, `locate`, and `updatedb`.
The browser and iOS examples resolve Pi itself from the registry too; no local
WebC build is needed. See `packages/pi` in the SDK repository for its source build.
