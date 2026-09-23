# Compile and run C with Clang

The `clang/clang@=0.160000.1` package includes the compiler, linker, and C
standard library. Both wasmer.sh and the iOS WasmerShell use this same example.
No npm or pip installation is needed. The initial compiler package download
is substantially larger than the example source.

## In the terminal

```sh
clang hello.c -o hello.wasm
./hello.wasm
./hello.wasm "C developer"
```

Both shells configure Clang's resource directory automatically through the
example's environment, including when you open the full shell. The SDK snippets
below set it in the sandbox's `env` option. To configure an existing Bash session
manually, use:

```sh
export CCC_OVERRIDE_OPTIONS='#^-resource-dir=/lib/clang/16'
```

Clang's [documented environment override](https://clang.llvm.org/docs/UsersManual.html#ccc-override-options)
prepends the resource-directory option (`^`) without diagnostic chatter (`#`).
Explicit command-line options still take precedence. This points Clang to this
package's builtin headers and libraries under `/lib/clang/16`; its executable
path would otherwise lead it to `/usr/lib/clang/16`.

The first run prints `Hello, Wasmer!`; the second uses your argument. Edit
`hello.c`, compile it again, and run the new `hello.wasm`. In wasmer.sh, use the
**Editor** panel to change the source.

The compiler itself runs as WebAssembly inside the SDK's sandbox. Bash launches
the resulting `.wasm` through the same SDK/WASIX runtime when you execute
`./hello.wasm`. No native compiler, remote build service, or separate Wasmer CLI
is required in either app. The generated binary stays in your workspace; it
is not bundled with the example.

## JavaScript SDK

This uses the same compile/read/load/run flow without a shell. Run it from a
browser application with `@wasmer/sdk` installed (use `@wasmer/sdk/node` for
native Node.js):

```js
import { Wasmer } from "@wasmer/sdk/browser";

const wasmer = new Wasmer();
let sandbox;
try {
  sandbox = await wasmer.sandboxes.create({
    packages: ["clang/clang@=0.160000.1"],
    env: { CCC_OVERRIDE_OPTIONS: "#^-resource-dir=/lib/clang/16" },
    files: {
      "hello.c": '#include <stdio.h>\nint main(void) { puts("Hello from C!"); return 0; }\n',
    },
  });
  // run() throws if compilation fails, so a stale binary is never run.
  await sandbox.command("clang", ["hello.c", "-o", "hello.wasm"]).run();
  const bytes = await sandbox.fs.readFile("hello.wasm");
  const program = await sandbox.installPackage(bytes);
  const output = await sandbox.command(program).run();
  console.log(output.text());
} finally {
  await sandbox?.close();
  await wasmer.close();
}
```

## Swift SDK

Use this inside an async Swift function with the `WasmerSDK` product:

```swift
import WasmerSDK

let wasmer = try Wasmer()
do {
    let sandbox = try await wasmer.sandboxes.create(
        packages: ["clang/clang@=0.160000.1"],
        env: ["CCC_OVERRIDE_OPTIONS": "#^-resource-dir=/lib/clang/16"]
    )
    do {
        try await sandbox.fs.writeText("hello.c", """
        #include <stdio.h>
        int main(void) { puts("Hello from C!"); return 0; }
        """)
        _ = try await sandbox.command("clang", ["hello.c", "-o", "hello.wasm"]).run()
        let bytes = try await sandbox.fs.read("hello.wasm")
        let program = try await sandbox.installPackage(.bytes(bytes))
        let output = try await sandbox.command(program).run()
        print(try output.text())
    } catch {
        try? await sandbox.close()
        throw error
    }
    try await sandbox.close()
} catch {
    try? await wasmer.close()
    throw error
}
try await wasmer.close()
```

Raw WASI/WASIX modules must export `_start`; the SDK exposes it as the package's
`main` command. Clang's default executable output provides this entrypoint.
