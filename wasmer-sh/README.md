# wasmer.sh

A fast, browser-native command shell powered by Wasmer, WASIX, and the new
[`@wasmer/sdk2`](../js) sandbox API.

The application loads `sharrattj/bash` as a package of Unix commands, creates
one persistent sandbox and launches each command as a real WASIX process. The
prompt, working directory and line editing live in the browser, while command
execution and the filesystem stay inside the sandbox. This keeps the terminal
responsive and makes process ownership explicit:

```ts
const wasmer = new Wasmer();
const unix = await wasmer.packages.load("sharrattj/bash");
const sandbox = await wasmer.sandboxes.create({
  packages: [
    unix,
    "wasmer/neatvi",
    "python/python",
    "wasmer/edgejs-quickjs",
    "php/php-32",
  ],
  files: { "hello.txt": "Hello from Wasmer.\n" },
});

const output = await sandbox.command("cat", ["hello.txt"]).run();
console.log(output.text());
```

The default shell therefore exposes Unix utilities alongside `python`, `edge`
and `php`:

```console
python -c "print('hello from Python')"
edge -e "console.log('hello from Edge.js')"
php -r "echo 'hello from PHP';"
```

Running `python`, `edge`, or `php` without arguments automatically selects
that runtime's interactive mode. Input is line-buffered by the browser shell,
with local echo, backspace, Ctrl-C termination, and Ctrl-D EOF handling.

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

The test verifies cross-origin isolation, waits for the sandbox, submits a
`printf` command and checks its generated output rather than terminal echo.

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
