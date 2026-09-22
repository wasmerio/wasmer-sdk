type SymbolHost = ((description?: string) => symbol) & {
  dispose?: symbol;
  asyncDispose?: symbol;
};

interface StackTraceTarget {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

interface ErrorHost {
  new (): { stack?: string };
  captureStackTrace?: (target: object, constructorOpt?: Function) => void;
  // Applications may return any value from this user-defined formatting hook.
  prepareStackTrace?: Function;
  stackTraceLimit?: number;
}

// Node's HTTP/readline builtins reference these symbols even when no `using`
// statement is executed. Older host engines may expose JSPI before disposal
// symbols. Supply the missing identities before Edge.js captures primordials;
// this does not implement explicit-resource-management syntax in the engine.
export function installNodeSymbols(symbol: SymbolHost = Symbol) {
  const installed = [];
  for (const name of ["dispose", "asyncDispose"] as const) {
    if (typeof symbol[name] === "symbol") continue;
    Object.defineProperty(symbol, name, { value: symbol(`Symbol.${name}`) });
    installed.push(name);
  }
  return installed;
}

installNodeSymbols();

// JavaScriptCore's captureStackTrace returns text even when prepareStackTrace
// asks for CallSites. Node dependencies such as depd rely on that hook. Keep
// native implementations when they support it; otherwise adapt captured JSC
// frames. Receiver/function objects and eval origins cannot be recovered from
// text, so those CallSite methods return undefined rather than invented values.
function callSite(frame: string) {
  const separator = frame.indexOf("@");
  if (separator < 0) return null;
  const name = frame.slice(0, separator) || null;
  const location = frame.slice(separator + 1);
  const match = /^(.*):(\d+):(\d+)$/.exec(location);
  const file = match?.[1] ?? null;
  return {
    getFileName: () => file,
    getScriptNameOrSourceURL: () => file,
    getLineNumber: () => match ? Number(match[2]) : null,
    getColumnNumber: () => match ? Number(match[3]) : null,
    getFunctionName: () => name,
    getMethodName: () => null,
    getTypeName: () => null,
    getThis: () => undefined,
    getFunction: () => undefined,
    getEvalOrigin: () => undefined,
    isEval: () => name === "eval code",
    isNative: () => location === "[native code]",
    isToplevel: () => !name,
    isConstructor: () => name?.startsWith("new ") ?? false,
    isAsync: () => name?.startsWith("async ") ?? false,
    isPromiseAll: () => false,
    getPromiseIndex: () => null,
    toString: () => name && location ? `${name} (${location})` : name || location || "<anonymous>",
  };
}

export function installNodeStackTrace(error: ErrorHost = Error) {
  const originalCapture = error.captureStackTrace;
  if (typeof originalCapture === "function") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "prepareStackTrace");
    const marker = {};
    try {
      error.prepareStackTrace = () => marker;
      const probe: StackTraceTarget = {};
      originalCapture.call(error, probe);
      if (probe.stack === marker) return false;
    } finally {
      if (descriptor) Object.defineProperty(error, "prepareStackTrace", descriptor);
      else delete error.prepareStackTrace;
    }
  }
  if (typeof error.stackTraceLimit !== "number") error.stackTraceLimit = 10;
  function captureStackTrace(target: StackTraceTarget, constructorOpt?: Function) {
    if ((typeof target !== "object" || target === null) && typeof target !== "function") {
      throw new TypeError("Error.captureStackTrace requires an object");
    }
    let raw;
    if (typeof originalCapture === "function") {
      const holder: StackTraceTarget = {};
      originalCapture.call(error, holder, constructorOpt ?? captureStackTrace);
      raw = holder.stack;
    } else {
      raw = new error().stack;
    }
    let frames = String(raw ?? "").split("\n").map(callSite).filter(frame => frame !== null);
    if (typeof originalCapture !== "function") {
      const name = constructorOpt?.name ?? "captureStackTrace";
      const index = frames.findIndex(frame => frame.getFunctionName() === name);
      frames = index < 0 ? [] : frames.slice(index + 1);
    }
    frames = frames.slice(0, Math.max(0, error.stackTraceLimit ?? 10));
    Object.defineProperty(target, "stack", {
      configurable: true,
      enumerable: false,
      get() {
        const value = typeof error.prepareStackTrace === "function"
          ? error.prepareStackTrace(target, frames)
          : `${target.name ?? "Error"}${target.message ? `: ${target.message}` : ""}` + frames.map(frame => `\n    at ${frame}`).join("");
        Object.defineProperty(target, "stack", { value, configurable: true, writable: true });
        return value;
      },
      set(value) { Object.defineProperty(target, "stack", { value, configurable: true, writable: true }); },
    });
  }
  Object.defineProperty(error, "captureStackTrace", { value: captureStackTrace, configurable: true, writable: true });
  return true;
}

installNodeStackTrace();
