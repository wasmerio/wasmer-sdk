# Pi coding agent for Wasmer

Pi 0.87.1 uses published Edge.js, coreutils, fd, ripgrep, grep, sed, findutils and curl packages. Its command runs
upstream's bundled CLI directly. Pi's JavaScript and package metadata are
unchanged; the package contains no Bash adapter or embedded runtime/search-tool
modules.

| Dependency | Version | Purpose |
| --- | --- | --- |
| `wasmer/edgejs` | `=0.2.4` | Node.js runtime, npm and pnpm |
| `wasmer/bash` | `=1.0.25` | Shell |
| `wasmer/coreutils` | `=1.0.27` | uutils commands including tail and nohup |
| `wasmer/fd` | `=10.5.1` | Pi's find tool |
| `wasmer/ripgrep` | `=15.2.1` | Pi's grep tool |
| `wasmer/grep` | `=3.12.0` | GNU grep for shell commands |
| `wasmer/sed` | `=4.9.0` | GNU sed for shell commands |
| `wasmer/findutils` | `=0.10.1` | uutils find, xargs, locate and updatedb |
| `curl/curl` | `=8.4.0` | HTTP/HTTPS requests and server checks |

The tool packages are available on both wasmer.io and wasmer.wtf. Their source
and reproducible build instructions live in [wasix-org/fd](https://github.com/wasix-org/fd),
[wasix-org/ripgrep](https://github.com/wasix-org/ripgrep),
[wasix-org/findutils](https://github.com/wasix-org/findutils),
and [wasix-org/coreutils](https://github.com/wasix-org/coreutils/blob/codex/refresh-wasix/WASIX.md).
The existing GNU grep and sed packages are reused. Package license notices are
mounted under `/opt/<package>/licenses`, leaving `/usr` available for command installation.

## Use the published package

The package is published as `wasmer/pi@0.87.1` on both
[wasmer.io](https://wasmer.io/wasmer/pi) and
[wasmer.wtf](https://wasmer.wtf/wasmer/pi). The wasmer.sh and WasmerShell Pi
examples load `wasmer/pi@=0.87.1` from the registry; select Pi and run `pi`.
No local package build is required to use either example.

## Build from source

Install Node.js, npm and the Wasmer CLI, then run from the SDK repository root:

```sh
bash packages/pi/build.sh
```

The output is `target/pi-0.87.1.webc`. Pass another output path as the first
argument to `build.sh`. No Edge.js checkout or Rust build is required.

The build installs the locked Pi dependencies with lifecycle scripts disabled
and omits native optional binaries. It then uses pinned `optimize-deps@0.1.2`
with NFT 1.11.0 to retain a conservative runtime layout. The published WebC
is 34,986,973 bytes (33.37 MiB), excluding shared dependencies.
All provider and OAuth entrypoints, the public
SDK runtime, extension support, image processing, themes, HTML export assets,
docs, examples and license notices are preserved. Source maps and TypeScript
declarations are omitted; runnable TypeScript examples remain.

Generated payloads live in `.build/runtime` and `.build/licenses`.
`.build/inventory.json` records every retained runtime file's size and SHA-256;
`.build/build.json` records optimizer versions and tracing warnings. The build
verifies that retained files are byte-identical to the locked npm install.
`LICENSE.pi` is the MIT license from upstream Pi's `v0.87.1` tag.

## Test and use

The SDK pins Wasmer's [`codex/pi-sdk-runtime`](https://github.com/wasmerio/wasmer/tree/codex/pi-sdk-runtime)
integration at `5bd2b7d3182e816bd0ea330acc88e4e4733e167f`. This includes the complete
[child-reaping fix (#6982)](https://github.com/wasmerio/wasmer/pull/6982), the filesystem
timestamp fix, merged N-API fixes, exec signal ownership, corrected redirected
stdio/socket-pair types, decoded Fetch response headers, and independent registration
of package command aliases so an unavailable `/usr/bin` path does not break `/bin/pi`.
It also includes [missing-PID signal errors (#7045)](https://github.com/wasmerio/wasmer/pull/7045).
Edge.js 0.2.4 handles detached spawning and signal errors in its native WASIX
bindings, so no JavaScript preload is needed. A normal SDK build uses the pinned sources;
`WASMER_REPO` is optional for local runtime development.

Both `npm` and `pnpm` invoke pnpm 10.34.5. Edge.js keeps real npm under
`edge-npm-internal` for pnpm's delegated operations without recursing into the alias.
To test:

```sh
WASMER_PI_SDK=/absolute/path/to/js/dist/node.js node packages/pi/test-sdk.mjs
```

The test loads only the Pi WebC, resolves its dependencies from the registry,
checks the commands, search behavior, shell pipelines, curl, nohup, tail and
nonblocking child waits, verifies shell launches with provider arguments, abort and
timeout, then exercises
all seven agent tools through `pi` with a local streaming model fixture. It uses no provider credentials or
paid API calls. For the native CLI, set `WASMER_BIN` to a compatible Wasmer build
and run `node packages/pi/test.mjs`.

The Bash tool runs without an adapter or `NODE_OPTIONS` preload. WASIX accepts
`detached: true` as ordinary spawning; it does not create a Unix process group.
Pi's cancellation falls back to terminating the immediate child, so descendant
processes may remain. Use **Restart** to stop the entire sandbox.

In wasmer.sh, select Pi and run `pi`. Pi is ready from its WebC
package, with the published runtime and tool dependencies. No npm installation
or local `pi-tools.webc` is needed.

The example's browser regression is:

```sh
cd wasmer-sh
WASMER_EXAMPLE=pi npm run test:examples
```

Use `/login` inside Pi to connect an AI provider with a subscription or API key,
then `/model` to choose a model. To expose all built-in tools,
pass `--tools read,write,edit,bash,grep,find,ls`.

Remaining runtime limits include: unbundled SDK JSON imports
on the JavaScript N-API host, the experimental plugin bundler's native esbuild
requirement, and tools such as Git that must be supplied by the surrounding
environment. Moving fd and ripgrep to dependencies does not change those limits.
The build and tests do not publish Pi.

To release the prepared package to both registries:

```sh
wasmer publish packages/pi --registry https://registry.wasmer.io/graphql --non-interactive --wait=container
wasmer publish packages/pi --registry https://registry.wasmer.wtf/graphql --non-interactive --wait=container
```

To test the published package instead of a local WebC:

```sh
node packages/pi/test-sdk.mjs wasmer/pi@=0.87.1
```
