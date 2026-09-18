// Check a real suspension across an event-loop turn, not just API presence.
// (module (import "env" "resume" (func (result i32)))
//   (func (export "run") (result i32) call 0 i32.const 1 i32.add))
const PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 127,
  2, 14, 1, 3, 101, 110, 118, 6, 114, 101, 115, 117, 109, 101, 0, 0,
  3, 2, 1, 0,
  7, 7, 1, 3, 114, 117, 110, 0, 1,
  10, 9, 1, 7, 0, 16, 0, 65, 1, 106, 11,
]);

export async function probeJSPI(wasm = WebAssembly) {
  try {
    if (typeof wasm.Suspending !== "function" || typeof wasm.promising !== "function") {
      throw new Error("Python requires WebAssembly JSPI; use iOS 27 or later");
    }
    let resumed = false;
    const instance = new wasm.Instance(new wasm.Module(PROBE), {
      env: {
        resume: new wasm.Suspending(() => new Promise((resolve) => {
          setTimeout(() => { resumed = true; resolve(41); }, 0);
        })),
      },
    });
    const result = await wasm.promising(instance.exports.run)();
    if (!resumed || result !== 42) throw new Error("JSPI suspend/resume probe failed");
    return { jspi: true };
  } catch (error) {
    return { jspi: false, jspiError: error?.message ?? String(error) };
  }
}
