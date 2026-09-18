
import { parse as wasmerNapiParse } from './acorn.mjs';

export function wasmer_napi_make_callback(dispatch) {
  return function (...args) {
    return dispatch(this, args);
  };
}
export function wasmer_napi_has_jspi() {
  return typeof WebAssembly.Suspending === 'function' &&
         typeof WebAssembly.promising === 'function';
}
export function wasmer_napi_instanceof(value, ctor) {
  return value instanceof ctor;
}
export function wasmer_napi_new(ctor, args) {
  return Reflect.construct(ctor, args);
}
export function wasmer_napi_symbol(description) {
  return Symbol(description);
}
export function wasmer_napi_string(value) {
  return String(value);
}
export function wasmer_napi_number(value) {
  return Number(value);
}
export function wasmer_napi_console_error(message) {
  console.error(message);
}
let wasmerNapiActiveGlobalContext;
const wasmerNapiBuffers = new WeakSet();
const wasmerNapiHostSetTimeout = globalThis.setTimeout.bind(globalThis);
const wasmerNapiHostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const wasmerNapiHostPromise = globalThis.Promise;
const wasmerNapiHostPromiseThen = globalThis.Promise.prototype.then;
let wasmerNapiPendingProviderWork = 0;
let wasmerNapiSettledProviderWork = false;
function wasmerNapiTrackHostPromise(value) {
  wasmerNapiPendingProviderWork += 1;
  const promise = wasmerNapiHostPromise.resolve(value);
  return wasmerNapiHostPromiseThen.call(
    promise,
    (result) => {
      wasmerNapiPendingProviderWork -= 1;
      wasmerNapiSettledProviderWork = true;
      return result;
    },
    (error) => {
      wasmerNapiPendingProviderWork -= 1;
      wasmerNapiSettledProviderWork = true;
      throw error;
    },
  );
}
export function wasmer_napi_has_pending_provider_work() {
  if (wasmerNapiPendingProviderWork !== 0) return true;
  if (!wasmerNapiSettledProviderWork) return false;
  wasmerNapiSettledProviderWork = false;
  return true;
}
const wasmerNapiYieldChannel = typeof globalThis.MessageChannel === 'function'
  ? new globalThis.MessageChannel()
  : undefined;
const wasmerNapiYieldResolvers = [];
const wasmerNapiMaxConsecutiveFastYields = 32;
let wasmerNapiConsecutiveFastYields = 0;
if (wasmerNapiYieldChannel !== undefined) {
  wasmerNapiYieldChannel.port1.onmessage = () => {
    const resolve = wasmerNapiYieldResolvers.shift();
    if (resolve !== undefined) resolve();
    if (wasmerNapiYieldResolvers.length === 0 &&
        typeof wasmerNapiYieldChannel.port1.unref === 'function') {
      wasmerNapiYieldChannel.port1.unref();
      wasmerNapiYieldChannel.port2.unref();
    }
  };
  if (typeof wasmerNapiYieldChannel.port1.start === 'function') {
    wasmerNapiYieldChannel.port1.start();
  }
  if (typeof wasmerNapiYieldChannel.port1.unref === 'function') {
    wasmerNapiYieldChannel.port1.unref();
    wasmerNapiYieldChannel.port2.unref();
  }
}
const wasmerNapiPromiseDetails = new WeakMap();
export function wasmer_napi_event_loop_checkpoint(allowHostTasks, hasRunnableWork) {
  // A Node microtask checkpoint must not admit timers, I/O, or messages. JSPI
  // still needs one suspension so the host engine can drain its Promise queue.
  if (!allowHostTasks) {
    return new wasmerNapiHostPromise((resolve) => {
      wasmerNapiHostQueueMicrotask(resolve);
    });
  }
  // Runnable libuv work only needs a host task boundary; MessageChannel
  // provides one without imposing a timer delay on every turn. Bound each
  // burst so a continuously-ready or stale native handle cannot monopolize
  // the host task queue; the timer turn is the scheduler fairness boundary.
  // Idle loops always use the timer path. Both primitives are captured from
  // the host realm and cannot be replaced by Node's guest global.
  const canYieldFast = hasRunnableWork &&
    wasmerNapiYieldChannel !== undefined &&
    wasmerNapiConsecutiveFastYields < wasmerNapiMaxConsecutiveFastYields;
  if (canYieldFast) {
    wasmerNapiConsecutiveFastYields += 1;
    return new wasmerNapiHostPromise((resolve) => {
      if (wasmerNapiYieldResolvers.length === 0 &&
          typeof wasmerNapiYieldChannel.port1.ref === 'function') {
        wasmerNapiYieldChannel.port1.ref();
        wasmerNapiYieldChannel.port2.ref();
      }
      wasmerNapiYieldResolvers.push(resolve);
      wasmerNapiYieldChannel.port2.postMessage(0);
    });
  }
  wasmerNapiConsecutiveFastYields = 0;
  return new wasmerNapiHostPromise((resolve) => wasmerNapiHostSetTimeout(resolve, 1));
}
export function wasmer_napi_enqueue_microtask(callback) {
  wasmerNapiHostQueueMicrotask(callback);
}
export function wasmer_napi_get_promise_details(promise) {
  let details = wasmerNapiPromiseDetails.get(promise);
  if (details === undefined) {
    details = { state: 0, result: undefined, hasResult: false };
    wasmerNapiPromiseDetails.set(promise, details);
    wasmerNapiHostPromiseThen.call(
      promise,
      (value) => {
        details.state = 1;
        details.result = value;
        details.hasResult = true;
      },
      (error) => {
        details.state = 2;
        details.result = error;
        details.hasResult = true;
      },
    );
  }
  return [details.state, details.result, details.hasResult];
}
const wasmerNapiHostStructuredClone =
  typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone.bind(globalThis)
    : undefined;
const wasmerNapiHostCapiShare = globalThis.__wasmerCapiShare?.bind(globalThis);
const wasmerNapiHostCapiObtain = globalThis.__wasmerCapiObtain?.bind(globalThis);
const wasmerNapiHostCapiWait = globalThis.__wasmerCapiWait?.bind(globalThis);
const wasmerNapiHostCapiDelete = globalThis.__wasmerCapiDelete?.bind(globalThis);
const wasmerNapiHostCapiMessageScope = globalThis.__wasmerCapiMessageScope?.bind(globalThis);
const wasmerNapiMessageRegistryId = 0x4e415049;
// wasm-bindgen-futures and Wasmer's JSPI glue schedule the suspended guest
// through these host-realm primitives. Edge installs Node-compatible globals
// with the same names in its own scope; mirroring those values onto the worker
// global would make the host executor recursively enter the suspended guest.
const wasmerNapiHostSchedulingGlobals = new Set([
  'Atomics',
  'Promise',
  'SharedArrayBuffer',
  'WebAssembly',
  'queueMicrotask',
  'setTimeout',
]);
// Web global operations are specified with a realm receiver. Copying one onto
// Edge's virtual global and invoking it there would otherwise throw "Illegal
// invocation" in browsers. Constructors and ECMAScript intrinsics remain
// unbound so their prototypes and identity semantics stay intact.
const wasmerNapiHostGlobalBindings = new Map();
for (const key of [
  'addEventListener',
  'close',
  'dispatchEvent',
  'postMessage',
  'queueMicrotask',
  'removeEventListener',
  'setTimeout',
  'structuredClone',
]) {
  const value = globalThis[key];
  if (typeof value === 'function') {
    wasmerNapiHostGlobalBindings.set(key, {
      raw: value,
      bound: value.bind(globalThis),
    });
  }
}
function wasmerNapiSnapshotGlobal() {
  return Object.getOwnPropertyDescriptors(globalThis);
}
function wasmerNapiSyncGlobalScope(context, snapshot) {
  const target = context.scopeTarget;
  for (const key of Reflect.ownKeys(target)) {
    if (key === 'global' || key === 'globalThis') continue;
    // Host scheduling primitives intentionally stay local to each N-API
    // context. Edge replaces some of them (notably setTimeout and
    // queueMicrotask) with Node-compatible implementations, while the worker
    // global must retain the originals for JSPI and wasm-bindgen scheduling.
    if (wasmerNapiHostSchedulingGlobals.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      try { delete target[key]; } catch {}
    }
  }
  for (const key of Reflect.ownKeys(snapshot)) {
    if (key === 'global' || key === 'globalThis') continue;
    if (wasmerNapiHostSchedulingGlobals.has(key) &&
        Object.prototype.hasOwnProperty.call(target, key)) {
      continue;
    }
    try {
      const descriptor = snapshot[key];
      const targetDescriptor = {
        configurable: true,
        enumerable: descriptor.enumerable,
      };
      if ('value' in descriptor) {
        targetDescriptor.writable = true;
        const hostBinding = wasmerNapiHostGlobalBindings.get(key);
        targetDescriptor.value = hostBinding !== undefined && descriptor.value === hostBinding.raw
          ? hostBinding.bound
          : descriptor.value;
      } else {
        targetDescriptor.get = descriptor.get;
        targetDescriptor.set = descriptor.set;
      }
      Object.defineProperty(target, key, targetDescriptor);
    } catch {}
  }
  Object.defineProperties(target, {
    global: { configurable: true, writable: true, value: context.scope },
    globalThis: { configurable: true, writable: true, value: context.scope },
  });
  return context.scope;
}
export function wasmer_napi_create_global_context() {
  const context = {
    scopeTarget: Object.create(null),
  };
  context.scope = new Proxy(context.scopeTarget, {
    has(target, key) {
      if (key === 'global' || key === 'globalThis') return true;
      return Reflect.has(target, key) || Reflect.has(globalThis, key);
    },
    get(target, key, receiver) {
      if (key === 'global' || key === 'globalThis') return receiver;
      if (Reflect.has(target, key)) {
        const value = Reflect.get(target, key, receiver);
        const hostBinding = wasmerNapiHostGlobalBindings.get(key);
        return hostBinding !== undefined && value === hostBinding.raw
          ? hostBinding.bound
          : value;
      }
      const value = Reflect.get(globalThis, key, globalThis);
      const hostBinding = wasmerNapiHostGlobalBindings.get(key);
      return hostBinding !== undefined && value === hostBinding.raw
        ? hostBinding.bound
        : value;
    },
    set(target, key, value, receiver) {
      Reflect.set(target, key, value, receiver);
      return true;
    },
    defineProperty(target, key, descriptor) {
      Reflect.defineProperty(target, key, descriptor);
      return true;
    },
    deleteProperty(target, key) {
      Reflect.deleteProperty(target, key);
      return true;
    },
  });
  wasmerNapiSyncGlobalScope(context, wasmerNapiSnapshotGlobal());
  return context;
}
export function wasmer_napi_global_context_scope(context) {
  return context.scope;
}
export function wasmer_napi_activate_global_context(context) {
  wasmerNapiActiveGlobalContext = context;
}
export function wasmer_napi_release_global_context(context) {
  if (wasmerNapiActiveGlobalContext !== context) return;
  wasmerNapiActiveGlobalContext = undefined;
}
export function wasmer_napi_context_eval(sandbox, source) {
  if (wasmerNapiActiveGlobalContext !== undefined &&
      (sandbox == null || sandbox === globalThis ||
       sandbox === wasmerNapiActiveGlobalContext.scope)) {
    sandbox = wasmerNapiActiveGlobalContext.scope;
  }
  if (sandbox == null) return (0, eval)(source);
  return Function('sandbox', 'source',
    'with (sandbox) { return eval(source); }')(sandbox, source);
}
function wasmerNapiLowerDynamicImports(params, source, filename) {
  const names = Array.from(params, String);
  const prefix = `(function(${names.join(',')}) {\n`;
  const program = wasmerNapiParse(`${prefix}${source}\n})`, {
    ecmaVersion: 'latest',
    sourceType: 'script',
  });
  const imports = [];
  const pending = [program];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node == null || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression') imports.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) pending.push(...child);
      else if (child != null && typeof child === 'object') pending.push(child);
    }
  }
  if (imports.length === 0) return source;

  const sourceSlice = (node) => {
    const start = node.start - prefix.length;
    const end = node.end - prefix.length;
    if (start < 0 || end < start || end > source.length) {
      throw new SyntaxError('dynamic import lies outside compiled function source');
    }
    return source.slice(start, end);
  };
  const referrer = JSON.stringify(String(filename ?? ''));
  const replacements = imports.map((node) => {
    const start = node.start - prefix.length;
    const end = node.end - prefix.length;
    const specifier = sourceSlice(node.source);
    const options = node.options == null ? '' : `, ${sourceSlice(node.options)}`;
    return {
      start,
      end,
      text: `__wasmerNapiTrackHostPromise(globalThis.process.__napi_dynamic_import(${specifier}, ${referrer}${options}))`,
    };
  }).sort((left, right) => right.start - left.start);

  for (const replacement of replacements) {
    source = source.slice(0, replacement.start) +
      replacement.text + source.slice(replacement.end);
  }
  return source;
}
export function wasmer_napi_compile_function(scope, contextExtensions, params, source, filename) {
  // V8's compile-function path accepts a hashbang for CommonJS entry files,
  // while the JavaScript Function constructor does not. Preserve byte and
  // line offsets by replacing only the hashbang marker with a line comment.
  if (source.startsWith('#!')) source = '//' + source.slice(2);
  source = wasmerNapiLowerDynamicImports(params, source, filename);
  const names = Array.from(params, String);
  const scopes = [scope, ...Array.from(contextExtensions ?? [])];
  const prefix = scopes.map((_, index) => `with (scopes[${index}]) {`).join('');
  const suffix = '}'.repeat(scopes.length);
  return Function('scopes', '__wasmerNapiTrackHostPromise',
    `${prefix} return function(${names.join(',')}) {\n${source}\n}; ${suffix}`)(
      scopes, wasmerNapiTrackHostPromise);
}
function wasmerNapiCollectBindingNames(pattern, names) {
  if (pattern == null) return;
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      wasmerNapiCollectBindingNames(property.type === 'RestElement' ? property.argument : property.value, names);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) wasmerNapiCollectBindingNames(element, names);
  } else if (pattern.type === 'AssignmentPattern') {
    wasmerNapiCollectBindingNames(pattern.left, names);
  } else if (pattern.type === 'RestElement') {
    wasmerNapiCollectBindingNames(pattern.argument, names);
  }
}
export function wasmer_napi_validate_script(source, filename) {
  wasmerNapiParse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    locations: true,
    sourceFile: filename,
  });
}
export function wasmer_napi_compile_module(scope, source, filename) {
  const program = wasmerNapiParse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  const requests = [];
  const exportNames = [];
  const replacements = [];
  const syntaxReplacements = [];
  let hasTopLevelAwait = false;
  const addExport = (name) => {
    name = String(name);
    if (!exportNames.includes(name)) exportNames.push(name);
  };
  const requestIndex = (node) => {
    const specifier = String(node.source.value);
    const index = requests.length;
    requests.push({ specifier, phase: 2, attributes: Object.create(null) });
    return index;
  };
  const text = (node) => source.slice(node.start, node.end);
  const exportedName = (node) => node.type === 'Identifier' ? node.name : String(node.value);

  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      const index = requestIndex(node);
      const statements = [];
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') {
          statements.push(`const ${specifier.local.name}=__imports[${index}].default;`);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          statements.push(`const ${specifier.local.name}=__imports[${index}];`);
        } else {
          const imported = exportedName(specifier.imported);
          statements.push(`const ${specifier.local.name}=__imports[${index}][${JSON.stringify(imported)}];`);
        }
      }
      replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      addExport('default');
      const declaration = node.declaration;
      if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `${lower(declaration)}\n__exports.default=${declaration.id.name};`,
        });
      } else {
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `__exports.default=(${lower(declaration)});`,
        });
      }
      continue;
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source != null) {
        const index = requestIndex(node);
        const statements = [];
        for (const specifier of node.specifiers) {
          const imported = exportedName(specifier.local);
          const exported = exportedName(specifier.exported);
          addExport(exported);
          statements.push(`__exports[${JSON.stringify(exported)}]=__imports[${index}][${JSON.stringify(imported)}];`);
        }
        replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      } else if (node.declaration != null) {
        const names = [];
        if (node.declaration.type === 'VariableDeclaration') {
          for (const declaration of node.declaration.declarations) {
            wasmerNapiCollectBindingNames(declaration.id, names);
          }
        } else if (node.declaration.id != null) {
          names.push(node.declaration.id.name);
        }
        for (const name of names) addExport(name);
        replacements.push({
          start: node.start,
          end: node.end,
          render: () => `${lower(node.declaration)}\n${names.map((name) => `__exports[${JSON.stringify(name)}]=${name};`).join('')}`,
        });
      } else {
        const statements = [];
        for (const specifier of node.specifiers) {
          const local = exportedName(specifier.local);
          const exported = exportedName(specifier.exported);
          addExport(exported);
          statements.push(`__exports[${JSON.stringify(exported)}]=${local};`);
        }
        replacements.push({ start: node.start, end: node.end, text: statements.join('') });
      }
      continue;
    }
    if (node.type === 'ExportAllDeclaration') {
      const index = requestIndex(node);
      if (node.exported != null) {
        const exported = exportedName(node.exported);
        addExport(exported);
        replacements.push({
          start: node.start,
          end: node.end,
          text: `__exports[${JSON.stringify(exported)}]=__imports[${index}];`,
        });
      } else {
        replacements.push({
          start: node.start,
          end: node.end,
          text: `for(const __key of Object.keys(__imports[${index}]))if(__key!=='default')__exports[__key]=__imports[${index}][__key];`,
        });
      }
    }
  }

  const pending = program.body.map((node) => ({ node, functionDepth: 0 }));
  while (pending.length !== 0) {
    const { node, functionDepth } = pending.pop();
    if (node == null || typeof node !== 'object') continue;
    const isFunction = /Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression';
    const childDepth = functionDepth + (isFunction ? 1 : 0);
    if (node.type === 'AwaitExpression' && functionDepth === 0) hasTopLevelAwait = true;
    if (node.type === 'ImportExpression') {
      const options = node.options == null ? '' : `, ${text(node.options)}`;
      syntaxReplacements.push({
        start: node.start,
        end: node.end,
        text: `__wasmerNapiTrackHostPromise(globalThis.process.__napi_dynamic_import(${text(node.source)},${JSON.stringify(String(filename ?? ''))}${options}))`,
      });
    } else if (node.type === 'MetaProperty' && node.meta?.name === 'import' && node.property?.name === 'meta') {
      syntaxReplacements.push({ start: node.start, end: node.end, text: '__importMeta' });
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const value of child) pending.push({ node: value, functionDepth: childDepth });
      } else if (child != null && typeof child === 'object') {
        pending.push({ node: child, functionDepth: childDepth });
      }
    }
  }

  function lower(node) {
    let result = text(node);
    const nested = syntaxReplacements
      .filter((replacement) => replacement.start >= node.start && replacement.end <= node.end)
      .sort((left, right) => right.start - left.start);
    for (const replacement of nested) {
      const start = replacement.start - node.start;
      const end = replacement.end - node.start;
      result = result.slice(0, start) + replacement.text + result.slice(end);
    }
    return result;
  }

  for (const replacement of replacements) {
    if (replacement.render !== undefined) replacement.text = replacement.render();
  }

  // Module-declaration replacements already include any syntax lowering in
  // their declaration/expression. Only apply standalone replacements here.
  for (const replacement of syntaxReplacements) {
    const enclosed = replacements.some((moduleReplacement) =>
      replacement.start >= moduleReplacement.start && replacement.end <= moduleReplacement.end);
    if (!enclosed) replacements.push(replacement);
  }
  replacements.sort((left, right) => right.start - left.start);
  let body = source;
  let replacedStart = source.length + 1;
  for (const replacement of replacements) {
    if (replacement.end > replacedStart) continue;
    body = body.slice(0, replacement.start) + replacement.text + body.slice(replacement.end);
    replacedStart = replacement.start;
  }
  const constructorBody = `${hasTopLevelAwait ? 'return async function' : 'return function'}(__imports,__exports,__importMeta){'use strict';\n${body}\n}`;
  const execute = Function('scope', '__wasmerNapiTrackHostPromise',
    `with(scope){${constructorBody}}`)(scope, wasmerNapiTrackHostPromise);
  return { requests, exportNames, hasTopLevelAwait, execute };
}
export function wasmer_napi_create_module_evaluation() {
  let resolve;
  let reject;
  const promise = new wasmerNapiHostPromise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}
export function wasmer_napi_finish_module_evaluation(
  evaluation, dependencies, execute, imports, namespace, importMeta) {
  wasmerNapiHostPromise.all(dependencies)
    .then(() => execute(imports, namespace, importMeta))
    .then(() => evaluation.resolve(undefined), evaluation.reject);
}
export function wasmer_napi_reject_module_evaluation(evaluation, error) {
  evaluation.reject(error);
}
export function wasmer_napi_typed_array(kind, buffer, offset, length) {
  const names = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'Float16Array'];
  const Ctor = globalThis[names[kind]];
  if (typeof Ctor !== 'function') throw new TypeError('unsupported typed array kind');
  return new Ctor(buffer, offset, length);
}
export function wasmer_napi_typed_array_kind(value) {
  const names = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'Float16Array'];
  // `instanceof globalThis.Uint8Array` rejects genuine views created through
  // Edge's virtual global (and any other same-origin realm). ArrayBuffer's
  // intrinsic brand check is realm-independent; the intrinsic tag then gives
  // us the N-API typed-array enum without trusting the current global's
  // constructors.
  if (!ArrayBuffer.isView(value)) return -1;
  const tag = Object.prototype.toString.call(value);
  return names.indexOf(tag.slice(8, -1));
}
export function wasmer_napi_is_arraybuffer(value) {
  try {
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(value);
    return true;
  } catch {
    return false;
  }
}
export function wasmer_napi_is_dataview(value) {
  try {
    Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get.call(value);
    return true;
  } catch {
    return false;
  }
}
export function wasmer_napi_is_buffer(value) {
  if (wasmerNapiBuffers.has(value)) return true;
  const activeBuffer = wasmerNapiActiveGlobalContext?.scopeTarget?.Buffer;
  if (typeof activeBuffer?.isBuffer === 'function' && activeBuffer.isBuffer(value)) {
    return true;
  }
  const hostBuffer = globalThis.Buffer;
  return hostBuffer !== activeBuffer &&
    typeof hostBuffer?.isBuffer === 'function' && hostBuffer.isBuffer(value);
}
export function wasmer_napi_buffer_view(buffer, offset, length) {
  const view = new Uint8Array(buffer, offset, length);
  wasmerNapiBuffers.add(view);
  const BufferCtor = wasmerNapiActiveGlobalContext?.scopeTarget?.Buffer ?? globalThis.Buffer;
  if (typeof BufferCtor === 'function' && BufferCtor.prototype != null) {
    Object.setPrototypeOf(view, BufferCtor.prototype);
  }
  return view;
}
export function wasmer_napi_get_all_property_names(value, mode, filter, conversion) {
  const result = [];
  const seen = new Set();
  let object = Object(value);
  while (object !== null) {
    for (const key of Reflect.ownKeys(object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof key === 'string') {
        if ((filter & 8) !== 0) continue;
      } else if ((filter & 16) !== 0) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) continue;
      if ((filter & 1) !== 0 && descriptor.writable !== true) continue;
      if ((filter & 2) !== 0 && descriptor.enumerable !== true) continue;
      if ((filter & 4) !== 0 && descriptor.configurable !== true) continue;

      if (conversion === 0 && typeof key === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(key)) {
        const index = Number(key);
        if (index <= 0xfffffffe) {
          result.push(index);
          continue;
        }
      }
      result.push(key);
    }
    if (mode === 1) break;
    object = Object.getPrototypeOf(object);
  }
  return result;
}
const wasmerNapiSerdesState = (() => {
  const key = Symbol.for('wasmer.napi.serdes.state');
  return globalThis[key] ||= { next: 1, values: new Map() };
})();
function wasmerNapiBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('buffer must be an ArrayBuffer or an ArrayBuffer view');
}
function wasmerNapiU32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, Number(value) >>> 0, true);
  return bytes;
}
export function wasmer_napi_structured_clone(value, transferList) {
  if (wasmerNapiHostStructuredClone === undefined) {
    throw new TypeError('structuredClone is not available in this JavaScript host');
  }
  return transferList === undefined
    ? wasmerNapiHostStructuredClone(value)
    : wasmerNapiHostStructuredClone(value, { transfer: Array.from(transferList) });
}
export function wasmer_napi_share_message(value, handle) {
  if (wasmerNapiHostCapiShare === undefined) {
    throw new TypeError('Wasmer host-value sharing is unavailable');
  }
  wasmerNapiHostCapiShare(wasmerNapiMessageRegistryId, handle, { value });
  return handle;
}
export function wasmer_napi_obtain_message(handle) {
  if (wasmerNapiHostCapiObtain === undefined) {
    throw new TypeError('Wasmer host-value sharing is unavailable');
  }
  const envelope = wasmerNapiHostCapiObtain(wasmerNapiMessageRegistryId, handle);
  if (envelope === undefined) {
    throw new TypeError(`Unknown N-API message payload ${handle}`);
  }
  return envelope.value;
}
export function wasmer_napi_wait_for_message(handle) {
  if (wasmerNapiHostCapiWait === undefined) {
    return Promise.reject(new TypeError('Wasmer host-value sharing is unavailable'));
  }
  return wasmerNapiHostCapiWait(wasmerNapiMessageRegistryId, handle);
}
export function wasmer_napi_release_message(handle) {
  wasmerNapiHostCapiDelete?.(wasmerNapiMessageRegistryId, handle);
}
export function wasmer_napi_message_scope() {
  return wasmerNapiHostCapiMessageScope?.() ?? 0;
}
export function wasmer_napi_create_serdes_binding() {
  class Serializer {
    constructor() {
      this.chunks = [];
      this.treatViewsAsHostObjects = false;
    }
    writeHeader() {
      this.chunks.push(Uint8Array.of(0x57, 0x53, 0x48, 0x31));
    }
    writeValue(value) {
      const id = wasmerNapiSerdesState.next++;
      const cloned = wasmerNapiHostStructuredClone !== undefined
        ? wasmerNapiHostStructuredClone(value)
        : value;
      wasmerNapiSerdesState.values.set(id, cloned);
      this.chunks.push(Uint8Array.of(0x57, 0x53, 0x56, 0x31), wasmerNapiU32(id));
      return true;
    }
    releaseBuffer() {
      const length = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of this.chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.chunks = [];
      return out;
    }
    transferArrayBuffer() {}
    writeUint32(value) { this.chunks.push(wasmerNapiU32(value)); }
    writeUint64(low, high = 0) {
      this.writeUint32(low);
      this.writeUint32(high);
    }
    writeDouble(value) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, Number(value), true);
      this.chunks.push(bytes);
    }
    writeRawBytes(value) { this.chunks.push(wasmerNapiBytes(value).slice()); }
    _setTreatArrayBufferViewsAsHostObjects(value) {
      this.treatViewsAsHostObjects = Boolean(value);
    }
  }
  class Deserializer {
    constructor(value) {
      this.buffer = value;
      this.bytes = wasmerNapiBytes(value);
      this.offset = 0;
    }
    readHeader() {
      if (this.bytes.length - this.offset < 4 ||
          this.bytes[this.offset] !== 0x57 || this.bytes[this.offset + 1] !== 0x53 ||
          this.bytes[this.offset + 2] !== 0x48 || this.bytes[this.offset + 3] !== 0x31) {
        return false;
      }
      this.offset += 4;
      return true;
    }
    readValue() {
      if (this.bytes.length - this.offset < 8 ||
          this.bytes[this.offset] !== 0x57 || this.bytes[this.offset + 1] !== 0x53 ||
          this.bytes[this.offset + 2] !== 0x56 || this.bytes[this.offset + 3] !== 0x31) {
        throw new Error('Invalid Wasmer serializer payload');
      }
      this.offset += 4;
      const id = this.readUint32();
      if (!wasmerNapiSerdesState.values.has(id)) {
        throw new Error('Wasmer serializer payload is no longer available');
      }
      const value = wasmerNapiSerdesState.values.get(id);
      wasmerNapiSerdesState.values.delete(id);
      return wasmerNapiHostStructuredClone !== undefined
        ? wasmerNapiHostStructuredClone(value)
        : value;
    }
    getWireFormatVersion() { return 15; }
    transferArrayBuffer() {}
    readUint32() {
      if (this.bytes.length - this.offset < 4) throw new RangeError('Unexpected end of buffer');
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4)
        .getUint32(0, true);
      this.offset += 4;
      return value;
    }
    readUint64() {
      const low = this.readUint32();
      const high = this.readUint32();
      return high * 0x100000000 + low;
    }
    readDouble() {
      if (this.bytes.length - this.offset < 8) throw new RangeError('Unexpected end of buffer');
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8)
        .getFloat64(0, true);
      this.offset += 8;
      return value;
    }
    _readRawBytes(length) {
      const size = Number(length) >>> 0;
      if (this.bytes.length - this.offset < size) throw new RangeError('Unexpected end of buffer');
      const offset = this.offset;
      this.offset += size;
      return offset;
    }
  }
  return { Serializer, Deserializer };
}
