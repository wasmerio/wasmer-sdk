# A window of your own, from C

`triangle.c` opens a window, draws in it with your GPU, and listens to you:
it is written against [`<wasmer/gui.h>`](include/wasmer/gui.h) for the
window and its input, and the standard
[`webgpu.h`](https://github.com/webgpu-native/webgpu-headers) for drawing.
Here it is compiled to WebAssembly by Clang, runs in the same sandbox as the
terminal, and its window is the canvas beside it. Nothing is prebuilt and
nothing leaves your machine.

## In the terminal

```sh
clang -Iinclude triangle.c lib/*.c -o triangle.wasm
./triangle.wasm
```

A canvas opens beside the terminal, with a triangle that spins. Click it,
so that it has the keyboard, and:

| Do | And |
| --- | --- |
| Drag, or press the left and right arrows | the triangle turns |
| Turn the wheel, or press up and down | it grows and shrinks |
| `F` | fullscreen, and back |
| `L` | the cursor is locked to the window, and the mouse turns the triangle; `Escape` gives it back |
| Space | it stops spinning, or starts again |
| `Q`, or `Escape` | the program ends |

Ctrl-C in the terminal ends it too. `./triangle.wasm 300` draws 300 frames
and exits on its own.

Make it yours: open the **Editor** and look at `handle_event` in
`triangle.c`. Every key, button and wheel notch arrives there as a record the
program reads when it wants to; nothing calls it back.

## What is in the workspace

| Path | What |
| --- | --- |
| `triangle.c` | The program: a window, a surface on it, and a loop that reads what happened and draws a frame |
| `include/wasmer/gui.h` | Windows, the keyboard, pointers, text entry and the clipboard for WASIX programs. No library comes with it: its functions are the host's |
| `include/webgpu/` | `webgpu.h`, unmodified, and the one addition a WASIX program needs to name what its surface presents to |
| `lib/` | Wasmer's implementation of `webgpu.h` for WASIX programs, as the C it is built from |

The program asks for a window and is given the canvas, at the size the panel
shows it; resize the panel and the program hears of it, and draws at the new
size. It names its drawing surface by what the window tells it
(`wguiWindowGetSurfaceSelector`), so the two are the same canvas. Fullscreen
and the cursor lock are things a browser only grants while you are doing
something: the program asks when you press the key, which is that moment.

The same source builds for the Wasmer CLI and the Wasmer SDKs, where the
window is a window of your desktop.
