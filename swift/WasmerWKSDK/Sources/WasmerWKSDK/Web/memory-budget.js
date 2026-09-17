// A prototype-local resource policy, installed in the coordinator and every
// guest worker before loading the SDK. Wasmer currently requests ~2 GiB shared
// guest maxima, including when cloning memory for fork. WebKit on iOS rejected
// the second command's {initial: 133, maximum: 32767, shared: true} allocation.
// A smaller memory maximum is valid for a Wasm import with a larger declared
// maximum. Never lower the initial size, and surface growth failures normally.
// Production integration should expose this policy in Wasmer's JS backend so
// its MemoryType metadata also records the effective resource limit.
const MAXIMUM_PAGES = 2048; // 128 MiB per shared guest memory.
const NativeMemory = WebAssembly.Memory;

// The SDK heap also holds decoded packages and dynamically linked modules.
// Python exhausted the former 128 MiB SDK cap before executing its script.
// Keep this separate from guest limits; memory grows from 25 pages on demand.
export function createRuntimeMemory() {
  return new NativeMemory({ initial: 25, maximum: 8192, shared: true }); // 512 MiB
}

WebAssembly.Memory = new Proxy(NativeMemory, {
  construct(target, [descriptor]) {
    if (descriptor.shared) {
      if (descriptor.initial > MAXIMUM_PAGES) {
        throw new RangeError("Guest requires more than the prototype's 128 MiB memory limit");
      }
      descriptor = { ...descriptor, maximum: Math.min(descriptor.maximum, MAXIMUM_PAGES) };
    }
    return Reflect.construct(target, [descriptor]);
  },
});
