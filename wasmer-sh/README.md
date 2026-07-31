# wasmer.sh

A fast, browser-native command shell powered by Wasmer, WASIX, and the new
[`@wasmer/sdk2`](../js) sandbox API.

The application loads `wasmer/bash`, creates one persistent sandbox, and
connects xterm to one long-lived interactive Bash process. Bash owns the
prompt, quoting, expansion, working directory, redirection, pipes, built-ins,
and child processes; the browser only transports terminal input and output.
Commands therefore have normal shell semantics instead of being parsed or
emulated by the UI:

```ts
const wasmer = new Wasmer();
const unix = await wasmer.packages.load("sharrattj/bash");
const sandbox = await wasmer.sandboxes.create({
  packages: [
    unix,
    "wasmer/neatvi",
    "python/python",
    "wasmer/edgejs-quickjs@0.1.1",
    "php/php-32",
  ],
  files: { ".bashrc": "PS1='wasmer@web:\\w$ '" },
});

const bash = await sandbox.command(
  unix,
  ["--rcfile", "/workspace/.bashrc", "-i"],
).spawn({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
```

The default shell therefore exposes Unix utilities alongside `python`, `edge`
and `php`:

```console
echo "hello" > hello.txt && cat hello.txt
find /workspace -type f | sort | head
python -c "print('hello from Python')"
edge -e "console.log('hello from Edge.js')"
php -r "echo 'hello from PHP';"
```

Running `python`, `edge`, or `php` without arguments automatically selects
that runtime's interactive mode. Those programs inherit the same Bash stdin
stream, so their REPLs return naturally to the shell when they exit.

Package data is persisted in the browser cache under the `wasmer.sh`
namespace, so subsequent sessions avoid downloading the same packages again.

## Run locally

From this directory:

```console
npm install
npm run dev
```

Vite serves the COOP and COEP headers required for `SharedArrayBuffer` and the
worker-backed WASIX runtime. A production host must serve the same headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Build and preview the static application with:

```console
npm run build
npm run preview
```

## Browser smoke test

Install Chromium once, then exercise a real registry package through the
browser terminal:

```console
npx playwright install chromium
npm test
```

The test verifies cross-origin isolation, checks real Bash arithmetic and file
redirection, and exercises the Python and Edge.js REPLs through Bash stdin.

## URL parameters

By default, wasmer.sh opens its command prompt. It can also launch another
package entrypoint directly without rebuilding the site:

| Parameter | Meaning |
| --- | --- |
| `package` | Main registry package; defaults to `sharrattj/bash` |
| `command` | Optional named command from the main package |
| `use` | Supporting package; repeat it to install several |
| `arg` | Process argument; repeat it to pass several |

For example:

```text
/?package=python/python&command=python&arg=-q
```
