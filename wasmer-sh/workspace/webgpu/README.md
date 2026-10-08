# Draw with your GPU from C

`triangle.c` is a C program written against the standard
[`webgpu.h`](https://github.com/webgpu-native/webgpu-headers). Here it is
compiled to WebAssembly by Clang, runs in the same sandbox as the terminal,
and draws with your browser's WebGPU. Nothing is prebuilt and nothing leaves
your machine.

## In the terminal

```sh
clang -Iinclude triangle.c lib/*.c -o triangle.wasm
./triangle.wasm
```

A canvas opens beside the terminal when the program creates its surface, and
a triangle starts to spin. Press Ctrl-C to stop it. `./triangle.wasm 300`
draws 300 frames and exits on its own.

Make it yours: open the **Editor**, change the colors or the shape in the
shader at the top of `triangle.c`, and run the two commands again.

## What is in the workspace

| Path | What |
| --- | --- |
| `triangle.c` | The program: a device, a render pipeline, and the frame loop a native WebGPU program writes |
| `include/webgpu/webgpu.h` | The upstream header, unmodified |
| `include/webgpu/webgpu_wasix.h` | The one addition a WASIX program needs: naming the canvas its surface presents to |
| `lib/` | Wasmer's implementation of `webgpu.h` for WASIX programs, as the C it is built from |

The program asks for a surface by name (`#canvas`); wasmer.sh answers with the
canvas beside the terminal, at the size the panel has when the program starts.
Calls that wait, such as `wgpuSurfacePresent`, really wait: the frame loop is
the one you would write for a desktop window, with no callbacks into
JavaScript and no `requestAnimationFrame`.

The same source builds for the Wasmer CLI and the Wasmer SDKs, where the
surface can be a native window. See
[wasmerio/webgpu](https://github.com/wasmerio/webgpu).

## Requirements

A browser with WebGPU and WebAssembly JavaScript Promise Integration, such as
a recent Chrome or Edge on a machine with a GPU.
