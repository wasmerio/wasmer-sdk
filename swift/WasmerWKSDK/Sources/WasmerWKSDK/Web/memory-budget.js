// A prototype-local resource policy, installed in the coordinator and every
// guest worker before loading the SDK. Wasmer currently requests ~2 GiB shared
// guest maxima, including when cloning memory for fork. WebKit on iOS rejected
// the second command's {initial: 133, maximum: 32767, shared: true} allocation.
// A smaller memory maximum is valid for a Wasm import with a larger declared
// maximum. Never lower the initial size, and surface growth failures normally.
// Production integration should expose this policy in Wasmer's JS backend so
// its MemoryType metadata also records the effective resource limit.
const maximumPages = 3072; // 192 MiB per shared guest memory.
const NativeMemory = WebAssembly.Memory;

// The SDK heap also holds decoded packages and dynamically linked modules.
// Keep room for the Node/Next.js compiler as well as Python's linked modules.
// Keep this separate from guest limits; memory grows from 25 pages on demand.
export function createRuntimeMemory() {
  return new NativeMemory({ initial: 25, maximum: 16384, shared: true }); // 1 GiB
}

WebAssembly.Memory = new Proxy(NativeMemory, {
  construct(target, [descriptor]) {
    if (descriptor.shared) {
      if (descriptor.initial > maximumPages) {
        throw new RangeError(`Guest requires more than the prototype's ${maximumPages / 16} MiB memory limit`);
      }
      descriptor = { ...descriptor, maximum: Math.min(descriptor.maximum, maximumPages) };
    }
    return Reflect.construct(target, [descriptor]);
  },
});
