/* @ts-self-types="./wasmer_sdk_js.d.ts" */
import { wasmer_napi_buffer_view, wasmer_napi_compile_function, wasmer_napi_compile_module, wasmer_napi_console_error, wasmer_napi_context_eval, wasmer_napi_create_serdes_binding, wasmer_napi_event_loop_checkpoint, wasmer_napi_get_all_property_names, wasmer_napi_number, wasmer_napi_obtain_message, wasmer_napi_release_message, wasmer_napi_share_message, wasmer_napi_string, wasmer_napi_structured_clone, wasmer_napi_typed_array, wasmer_napi_validate_script, wasmer_napi_wait_for_message } from './snippets/wasmer-napi-4dc421676e010b84/inline0.js';
import * as import1 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import2 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import3 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import4 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import5 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import6 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import7 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import8 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import9 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import10 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import11 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import12 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import13 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import14 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import15 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import16 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import17 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import18 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import19 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"
import * as import20 from "./snippets/wasmer-napi-4dc421676e010b84/inline0.js"


export class CommandCore {
    static __wrap(ptr) {
        const obj = Object.create(CommandCore.prototype);
        obj.__wbg_ptr = ptr;
        CommandCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CommandCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_commandcore_free(ptr, 0);
    }
    /**
     * @param {string[]} args
     */
    args(args) {
        const ptr0 = passArrayJsValueToWasm0(args, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_args(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} path
     */
    currentDir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_currentDir(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} key
     * @param {string} value
     */
    env(key, value) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_env(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {Uint8Array} bytes
     */
    input(bytes) {
        const ret = wasm.commandcore_input(this.__wbg_ptr, bytes);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} bytes
     */
    outputBytes(bytes) {
        const ret = wasm.commandcore_outputBytes(this.__wbg_ptr, bytes);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {Promise<OutputCore>}
     */
    run() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.commandcore_run(ptr);
        return ret;
    }
    /**
     * @returns {Promise<ProcessCore>}
     */
    spawn() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.commandcore_spawn(ptr);
        return ret;
    }
    /**
     * Live stderr mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
     * @param {string} mode
     */
    stderrMode(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_stderrMode(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Live stdin mode for `spawn()`: `"pipe"` or `"closed"`.
     * @param {string} mode
     */
    stdinMode(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_stdinMode(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Live stdout mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
     * @param {string} mode
     */
    stdoutMode(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.commandcore_stdoutMode(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Attach an interactive terminal with the given character dimensions.
     * @param {number} columns
     * @param {number} rows
     */
    terminal(columns, rows) {
        const ret = wasm.commandcore_terminal(this.__wbg_ptr, columns, rows);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} milliseconds
     */
    timeoutMs(milliseconds) {
        const ret = wasm.commandcore_timeoutMs(this.__wbg_ptr, milliseconds);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) CommandCore.prototype[Symbol.dispose] = CommandCore.prototype.free;

export class HttpResponseCore {
    static __wrap(ptr) {
        const obj = Object.create(HttpResponseCore.prototype);
        obj.__wbg_ptr = ptr;
        HttpResponseCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HttpResponseCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_httpresponsecore_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get body() {
        const ret = wasm.httpresponsecore_body(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {any}
     */
    get headers() {
        const ret = wasm.httpresponsecore_headers(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get status() {
        const ret = wasm.httpresponsecore_status(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get statusText() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.httpresponsecore_statusText(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) HttpResponseCore.prototype[Symbol.dispose] = HttpResponseCore.prototype.free;

export class OutputCore {
    static __wrap(ptr) {
        const obj = Object.create(OutputCore.prototype);
        obj.__wbg_ptr = ptr;
        OutputCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OutputCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_outputcore_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get exitCode() {
        const ret = wasm.outputcore_exitCode(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get ok() {
        const ret = wasm.outputcore_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Why the process stopped: `"exited"`, `"terminated"`, or `"timeout"`.
     * @returns {string}
     */
    get reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.outputcore_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    get stderr() {
        const ret = wasm.outputcore_stderr(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get stderrTruncated() {
        const ret = wasm.outputcore_stderrTruncated(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get stdout() {
        const ret = wasm.outputcore_stdout(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get stdoutTruncated() {
        const ret = wasm.outputcore_stdoutTruncated(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) OutputCore.prototype[Symbol.dispose] = OutputCore.prototype.free;

export class PackageCore {
    static __wrap(ptr) {
        const obj = Object.create(PackageCore.prototype);
        obj.__wbg_ptr = ptr;
        PackageCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PackageCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packagecore_free(ptr, 0);
    }
    /**
     * @returns {string[]}
     */
    get commands() {
        const ret = wasm.packagecore_commands(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string | undefined}
     */
    get entrypoint() {
        const ret = wasm.packagecore_entrypoint(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {string} name
     * @returns {boolean}
     */
    hasCommand(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packagecore_hasCommand(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    get id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.packagecore_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) PackageCore.prototype[Symbol.dispose] = PackageCore.prototype.free;

export class ProcessCore {
    static __wrap(ptr) {
        const obj = Object.create(ProcessCore.prototype);
        obj.__wbg_ptr = ptr;
        ProcessCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processcore_free(ptr, 0);
    }
    /**
     * @returns {Promise<void>}
     */
    closeStdin() {
        const ret = wasm.processcore_closeStdin(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get id() {
        const ret = wasm.processcore_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    kill() {
        wasm.processcore_kill(this.__wbg_ptr);
    }
    /**
     * @param {number} max_bytes
     * @returns {Promise<any>}
     */
    readStderr(max_bytes) {
        const ret = wasm.processcore_readStderr(this.__wbg_ptr, max_bytes);
        return ret;
    }
    /**
     * @param {number} max_bytes
     * @returns {Promise<any>}
     */
    readStdout(max_bytes) {
        const ret = wasm.processcore_readStdout(this.__wbg_ptr, max_bytes);
        return ret;
    }
    /**
     * @param {number} columns
     * @param {number} rows
     */
    resizeTerminal(columns, rows) {
        const ret = wasm.processcore_resizeTerminal(this.__wbg_ptr, columns, rows);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} grace_ms
     * @returns {Promise<void>}
     */
    terminate(grace_ms) {
        const ret = wasm.processcore_terminate(this.__wbg_ptr, grace_ms);
        return ret;
    }
    /**
     * @returns {Promise<OutputCore>}
     */
    wait() {
        const ret = wasm.processcore_wait(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<void>}
     */
    writeStdin(bytes) {
        const ret = wasm.processcore_writeStdin(this.__wbg_ptr, bytes);
        return ret;
    }
}
if (Symbol.dispose) ProcessCore.prototype[Symbol.dispose] = ProcessCore.prototype.free;

export class SandboxBuilderCore {
    static __wrap(ptr) {
        const obj = Object.create(SandboxBuilderCore.prototype);
        obj.__wbg_ptr = ptr;
        SandboxBuilderCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SandboxBuilderCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sandboxbuildercore_free(ptr, 0);
    }
    /**
     * @param {string} key
     * @param {string} value
     */
    env(key, value) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxbuildercore_env(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} path
     * @param {Uint8Array} bytes
     */
    file(path, bytes) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxbuildercore_file(this.__wbg_ptr, ptr0, len0, bytes);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Experimental worker-only native directory mount. The embedder installs
     * the synchronous `__wasmerHostFileSystem` bridge on every SDK worker.
     * @param {string} path
     * @param {number} mount_id
     * @param {boolean} read_only
     */
    mountHost(path, mount_id, read_only) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxbuildercore_mountHost(this.__wbg_ptr, ptr0, len0, mount_id, read_only);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure guest networking from a stable mode string.
     * @param {string} mode
     */
    network(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxbuildercore_network(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure browser HTTP ingress and WISP-backed TCP/DNS egress.
     * @param {any} bridge
     */
    networkWisp(bridge) {
        const ret = wasm.sandboxbuildercore_networkWisp(this.__wbg_ptr, bridge);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {PackageCore} _package
     */
    package(_package) {
        _assertClass(_package, PackageCore);
        const ret = wasm.sandboxbuildercore_package(this.__wbg_ptr, _package.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {Promise<SandboxCore>}
     */
    start() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.sandboxbuildercore_start(ptr);
        return ret;
    }
}
if (Symbol.dispose) SandboxBuilderCore.prototype[Symbol.dispose] = SandboxBuilderCore.prototype.free;

export class SandboxCore {
    static __wrap(ptr) {
        const obj = Object.create(SandboxCore.prototype);
        obj.__wbg_ptr = ptr;
        SandboxCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SandboxCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sandboxcore_free(ptr, 0);
    }
    /**
     * @returns {Promise<void>}
     */
    close() {
        const ret = wasm.sandboxcore_close(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} name
     * @returns {CommandCore}
     */
    command(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_command(this.__wbg_ptr, ptr0, len0);
        return CommandCore.__wrap(ret);
    }
    /**
     * @param {PackageCore} _package
     * @returns {CommandCore}
     */
    commandPackage(_package) {
        _assertClass(_package, PackageCore);
        const ret = wasm.sandboxcore_commandPackage(this.__wbg_ptr, _package.__wbg_ptr);
        return CommandCore.__wrap(ret);
    }
    /**
     * A command explicitly qualified by its package, resolving name
     * collisions between installed packages.
     * @param {PackageCore} _package
     * @param {string} name
     * @returns {CommandCore}
     */
    commandRef(_package, name) {
        _assertClass(_package, PackageCore);
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_commandRef(this.__wbg_ptr, _package.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CommandCore.__wrap(ret[0]);
    }
    /**
     * Forward one structured HTTP request into a guest TCP listener.
     * @param {number} port
     * @param {string} method
     * @param {string} path
     * @param {any} headers
     * @param {Uint8Array} body
     * @returns {Promise<HttpResponseCore>}
     */
    handleHttpRequest(port, method, path, headers, body) {
        const ptr0 = passStringToWasm0(method, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_handleHttpRequest(this.__wbg_ptr, port, ptr0, len0, ptr1, len1, headers, body);
        return ret;
    }
    /**
     * Browser HTTP ingress ports currently owned by guest listeners.
     * @returns {Uint16Array | undefined}
     */
    httpListeningPorts() {
        const ret = wasm.sandboxcore_httpListeningPorts(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        }
        return v1;
    }
    /**
     * @param {string} specifier
     * @returns {Promise<PackageCore>}
     */
    installPackage(specifier) {
        const ptr0 = passStringToWasm0(specifier, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_installPackage(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<PackageCore>}
     */
    installPackageBytes(bytes) {
        const ret = wasm.sandboxcore_installPackageBytes(this.__wbg_ptr, bytes);
        return ret;
    }
    /**
     * @param {PackageCore} _package
     * @returns {Promise<PackageCore>}
     */
    installPackageRef(_package) {
        _assertClass(_package, PackageCore);
        const ret = wasm.sandboxcore_installPackageRef(this.__wbg_ptr, _package.__wbg_ptr);
        return ret;
    }
    /**
     * Whether a browser HTTP ingress listener exists on `port`.
     * @param {number} port
     * @returns {boolean}
     */
    isHttpPortListening(port) {
        const ret = wasm.sandboxcore_isHttpPortListening(this.__wbg_ptr, port);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} path
     * @param {boolean} recursive
     */
    mkdir(path, recursive) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_mkdir(this.__wbg_ptr, ptr0, len0, recursive);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} path
     * @returns {any}
     */
    readDir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_readDir(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {string} path
     * @returns {Promise<Uint8Array>}
     */
    readFile(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_readFile(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {string} path
     * @param {boolean} recursive
     */
    remove(path, recursive) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_remove(this.__wbg_ptr, ptr0, len0, recursive);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} from
     * @param {string} to
     * @returns {Promise<void>}
     */
    rename(from, to) {
        const ptr0 = passStringToWasm0(from, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_rename(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * @param {string} path
     * @returns {any}
     */
    stat(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_stat(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Wait until a guest TCP listener accepts connections on `port`.
     * @param {number} port
     * @param {number} timeout_ms
     * @returns {Promise<void>}
     */
    waitForPort(port, timeout_ms) {
        const ret = wasm.sandboxcore_waitForPort(this.__wbg_ptr, port, timeout_ms);
        return ret;
    }
    /**
     * @param {string} path
     * @param {Uint8Array} bytes
     * @returns {Promise<void>}
     */
    writeFile(path, bytes) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sandboxcore_writeFile(this.__wbg_ptr, ptr0, len0, bytes);
        return ret;
    }
}
if (Symbol.dispose) SandboxCore.prototype[Symbol.dispose] = SandboxCore.prototype.free;

/**
 * The Rust state for a worker in the threadpool.
 */
export class ThreadPoolWorker {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ThreadPoolWorkerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_threadpoolworker_free(ptr, 0);
    }
    /**
     * Release worker-local JS roots after the scheduler has dropped finished
     * process ownership. Collection before sending Idle is too early: the
     * scheduler still owns the process at that point.
     */
    collectSharedObjects() {
        wasm.threadpoolworker_collectSharedObjects(this.__wbg_ptr);
    }
    /**
     * @param {any} msg
     * @returns {Promise<void>}
     */
    handle(msg) {
        const ret = wasm.threadpoolworker_handle(this.__wbg_ptr, msg);
        return ret;
    }
    /**
     * @param {number} id
     */
    constructor(id) {
        const ret = wasm.threadpoolworker_new(id);
        this.__wbg_ptr = ret;
        ThreadPoolWorkerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ThreadPoolWorker.prototype[Symbol.dispose] = ThreadPoolWorker.prototype.free;

/**
 * A struct representing a Trap
 */
export class Trap {
    static __wrap(ptr) {
        const obj = Object.create(Trap.prototype);
        obj.__wbg_ptr = ptr;
        TrapFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_trap_free(ptr, 0);
    }
    /**
     * A marker method to indicate that an object is an instance of the `Trap`
     * class.
     */
    static __wbg_wasmer_trap() {
        wasm.trap___wbg_wasmer_trap();
    }
}
if (Symbol.dispose) Trap.prototype[Symbol.dispose] = Trap.prototype.free;

export class WasmerCore {
    static __wrap(ptr) {
        const obj = Object.create(WasmerCore.prototype);
        obj.__wbg_ptr = ptr;
        WasmerCoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmerCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmercore_free(ptr, 0);
    }
    /**
     * @param {any} options
     * @param {any | null} [node_network]
     * @param {any | null} [node_cache]
     * @returns {WasmerCore}
     */
    static create(options, node_network, node_cache) {
        const ret = wasm.wasmercore_create(options, isLikeNone(node_network) ? 0 : addToExternrefTable0(node_network), isLikeNone(node_cache) ? 0 : addToExternrefTable0(node_cache));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmerCore.__wrap(ret[0]);
    }
    /**
     * @param {any} definition
     * @returns {Promise<PackageCore>}
     */
    createPackage(definition) {
        const ret = wasm.wasmercore_createPackage(this.__wbg_ptr, definition);
        return ret;
    }
    /**
     * @param {string} specifier
     * @returns {Promise<PackageCore>}
     */
    loadPackage(specifier) {
        const ptr0 = passStringToWasm0(specifier, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmercore_loadPackage(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<PackageCore>}
     */
    loadPackageBytes(bytes) {
        const ret = wasm.wasmercore_loadPackageBytes(this.__wbg_ptr, bytes);
        return ret;
    }
    /**
     * @returns {SandboxBuilderCore}
     */
    sandbox() {
        const ret = wasm.wasmercore_sandbox(this.__wbg_ptr);
        return SandboxBuilderCore.__wrap(ret);
    }
    /**
     * @returns {Promise<void>}
     */
    shutdown() {
        const ret = wasm.wasmercore_shutdown(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmerCore.prototype[Symbol.dispose] = WasmerCore.prototype.free;

export function initialize() {
    wasm.initialize();
}

/**
 * @param {string} url
 */
export function setSDKUrl(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.setSDKUrl(ptr0, len0);
}

/**
 * @param {string} url
 */
export function setWorkerUrl(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.setWorkerUrl(ptr0, len0);
}
function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg_BigInt_9fb73aa817d633b1: function(arg0) {
            const ret = BigInt(arg0);
            return ret;
        },
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_9a4e0ecb0fa16705: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wasmerHostConnectTcp_1c793aaaa70bd4b5: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            let deferred0_0;
            let deferred0_1;
            let deferred1_0;
            let deferred1_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                deferred1_0 = arg3;
                deferred1_1 = arg4;
                const ret = globalThis.__wasmerHostConnectTcp(arg0 >>> 0, getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
                wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
            }
        }, arguments); },
        __wbg___wasmerHostFileSystem_078382029be10ce3: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = globalThis.__wasmerHostFileSystem(arg0 >>> 0, getStringFromWasm0(arg1, arg2), arg3);
            return ret;
        }, arguments); },
        __wbg___wasmerHostListenTcp_9d4fb8533d6bb29b: function() { return handleError(function (arg0, arg1, arg2) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                const ret = globalThis.__wasmerHostListenTcp(arg0 >>> 0, getStringFromWasm0(arg1, arg2));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg___wasmerHostListenerAccept_683bc35e002fc17f: function() { return handleError(function (arg0, arg1) {
            const ret = globalThis.__wasmerHostListenerAccept(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostListenerClose_66b3159b7aa311a3: function() { return handleError(function (arg0, arg1) {
            globalThis.__wasmerHostListenerClose(arg0 >>> 0, arg1 >>> 0);
        }, arguments); },
        __wbg___wasmerHostListenerReadable_5f22b19a93b42bed: function() { return handleError(function (arg0, arg1) {
            const ret = globalThis.__wasmerHostListenerReadable(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostListenerRefresh_eeafcc5daa68bc6a: function() { return handleError(function (arg0, arg1) {
            globalThis.__wasmerHostListenerRefresh(arg0 >>> 0, arg1 >>> 0);
        }, arguments); },
        __wbg___wasmerHostResolve_95b379ca730530ea: function() { return handleError(function (arg0, arg1, arg2) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                const ret = globalThis.__wasmerHostResolve(arg0 >>> 0, getStringFromWasm0(arg1, arg2));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg___wasmerHostSocketClose_ded58752be250fdc: function() { return handleError(function (arg0, arg1) {
            globalThis.__wasmerHostSocketClose(arg0 >>> 0, arg1 >>> 0);
        }, arguments); },
        __wbg___wasmerHostSocketFlush_fdaee379cd3ea3e8: function() { return handleError(function (arg0, arg1) {
            const ret = globalThis.__wasmerHostSocketFlush(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostSocketRead_0bc7bb580827afb1: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = globalThis.__wasmerHostSocketRead(arg0 >>> 0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostSocketReadable_cbcda83aaa296554: function() { return handleError(function (arg0, arg1) {
            const ret = globalThis.__wasmerHostSocketReadable(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostSocketRefresh_c13392394b2b6c10: function() { return handleError(function (arg0, arg1) {
            globalThis.__wasmerHostSocketRefresh(arg0 >>> 0, arg1 >>> 0);
        }, arguments); },
        __wbg___wasmerHostSocketSetKeepAlive_477eb065ceb879ca: function() { return handleError(function (arg0, arg1, arg2) {
            globalThis.__wasmerHostSocketSetKeepAlive(arg0 >>> 0, arg1 >>> 0, arg2 !== 0);
        }, arguments); },
        __wbg___wasmerHostSocketSetNoDelay_a21ac25d713dc7ec: function() { return handleError(function (arg0, arg1, arg2) {
            globalThis.__wasmerHostSocketSetNoDelay(arg0 >>> 0, arg1 >>> 0, arg2 !== 0);
        }, arguments); },
        __wbg___wasmerHostSocketWritable_1e3cb0d81de36af8: function() { return handleError(function (arg0, arg1) {
            const ret = globalThis.__wasmerHostSocketWritable(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wasmerHostSocketWrite_5446f80f84c09b97: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = globalThis.__wasmerHostSocketWrite(arg0 >>> 0, arg1 >>> 0, getArrayU8FromWasm0(arg2, arg3));
            return ret;
        }, arguments); },
        __wbg___wasmerNodeCacheGet_48e5b658cde9454d: function() { return handleError(function (arg0, arg1, arg2) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                const ret = globalThis.__wasmerNodeCacheGet(arg0 >>> 0, getStringFromWasm0(arg1, arg2));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg___wasmerNodeCachePut_387fe382a6907a0b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                const ret = globalThis.__wasmerNodeCachePut(arg0 >>> 0, getStringFromWasm0(arg1, arg2), getArrayU8FromWasm0(arg3, arg4));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg___wasmerNodeCacheRemove_b8ffd7b8b007502c: function() { return handleError(function (arg0, arg1, arg2) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg1;
                deferred0_1 = arg2;
                const ret = globalThis.__wasmerNodeCacheRemove(arg0 >>> 0, getStringFromWasm0(arg1, arg2));
                return ret;
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64((arg0 >>> 0) + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_function_table_808ea415bac79cd6: function() {
            const ret = wasm.__wbindgen_export;
            return ret;
        },
        __wbg___wbindgen_in_aca499c5de7ff5e5: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_2f76dc55065b4273: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_falsy_a6dfe792ff282f10: function(arg0) {
            const ret = !arg0;
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_ea9085d691f535d3: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_symbol_0c0690b48e92ec04: function(arg0) {
            const ret = typeof(arg0) === 'symbol';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_e659fcf7b0e32763: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_lt_f5e407c37b70b8b0: function(arg0, arg1) {
            const ret = arg0 < arg1;
            return ret;
        },
        __wbg___wbindgen_memory_de265df8aadd6273: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_module_a22faa8909381977: function() {
            const ret = wasmModule;
            return ret;
        },
        __wbg___wbindgen_neg_69ea89900918a95f: function(arg0) {
            const ret = -arg0;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64((arg0 >>> 0) + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_rethrow_4915403b40f010b4: function(arg0) {
            throw arg0;
        },
        __wbg___wbindgen_shr_ad10001a7b001d7f: function(arg0, arg1) {
            const ret = arg0 >> arg1;
            return ret;
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_fffb441def202758: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_add_2bf30d748e613446: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.add(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_add_5d7c5610a9914671: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.add(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_and_1d7a7ff9e0e4dd99: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.and(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_and_ff0bc29d978e1d9a: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.and(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_apply_23dd4d2439189415: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.apply(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_apply_3ac86a26fdb56c05: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.apply(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_arrayBuffer_3b637f0fa65c5351: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_assert_0d938b2809f565c4: function(arg0, arg1) {
            console.assert(arg0 !== 0, arg1);
        },
        __wbg_async_37b7cd4cbabb646c: function(arg0) {
            const ret = arg0.async;
            return ret;
        },
        __wbg_bind_7a0202e6587a08e9: function(arg0, arg1, arg2) {
            const ret = arg0.bind(arg1, arg2);
            return ret;
        },
        __wbg_bind_ed119fc9a791cb9c: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.bind(arg1, arg2, arg3);
            return ret;
        },
        __wbg_buffer_0f212447ac64c53b: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_buffer_54b87055582c8a81: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_buffer_c55b4fec56be2713: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byteLength_47eafd0bff4dce39: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteLength_b449ddccf9a5f01d: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_caches_8dc528cff9e7c01b: function() { return handleError(function (arg0) {
            const ret = arg0.caches;
            return ret;
        }, arguments); },
        __wbg_caches_9c7b5dcbb721183a: function() { return handleError(function (arg0) {
            const ret = arg0.caches;
            return ret;
        }, arguments); },
        __wbg_call_44b7209e1e252e6a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
            return ret;
        }, arguments); },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_colno_39c621e1e9d33446: function(arg0) {
            const ret = arg0.colno;
            return ret;
        },
        __wbg_compareExchange_79be40953908378b: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = Atomics.compareExchange(arg0, arg1 >>> 0, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_compareExchange_95faf728c239fd0b: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = Atomics.compareExchange(arg0, arg1 >>> 0, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_compile_6372456a133997b2: function(arg0) {
            const ret = WebAssembly.compile(arg0);
            return ret;
        },
        __wbg_constructor_07a76432cc61e2e7: function(arg0) {
            const ret = arg0.constructor;
            return ret;
        },
        __wbg_createObjectURL_416e527781e6fd6d: function() { return handleError(function (arg0, arg1) {
            const ret = URL.createObjectURL(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_customSections_3702745a55d47b3d: function(arg0, arg1, arg2) {
            const ret = WebAssembly.Module.customSections(arg0, getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_data_0965368f2b7f680a: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_data_328de4280640da92: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_defineProperty_d680f9c4ff344910: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.defineProperty(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_deleteProperty_36be13e7a282429c: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.deleteProperty(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_delete_f809d7e5c6e4bdf1: function(arg0, arg1, arg2) {
            const ret = arg0.delete(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_deref_e6425a8fa9d03a9d: function(arg0) {
            const ret = arg0.deref();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_done_89b2b13e91a60321: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_encodeURIComponent_d0140ae6e13eb27b: function(arg0, arg1) {
            const ret = encodeURIComponent(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_entries_015dc610cd81ede0: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_744744ff0c9861e6: function(arg0) {
            console.error(arg0);
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_exchange_7f987be6298549a9: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.exchange(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_exchange_8655ed82aefa27f5: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.exchange(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_exports_085d8a69333b42bc: function(arg0) {
            const ret = arg0.exports;
            return ret;
        },
        __wbg_exports_992a7d99df0efe82: function(arg0) {
            const ret = WebAssembly.Module.exports(arg0);
            return ret;
        },
        __wbg_fetch_6ecc661950e58d49: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_b5951fc96f52f786: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_filename_bac9074e00c4ac8d: function(arg0, arg1) {
            const ret = arg1.filename;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_for_e542e480b076809a: function(arg0, arg1) {
            const ret = Symbol.for(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_freeze_2a97df119e6d5e2a: function(arg0) {
            const ret = Object.freeze(arg0);
            return ret;
        },
        __wbg_from_13e323c65fc8f464: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_getOwnPropertyDescriptor_c34a1042b0d32e75: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.getOwnPropertyDescriptor(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_getPrototypeOf_086802da20be2dba: function() { return handleError(function (arg0) {
            const ret = Reflect.getPrototypeOf(arg0);
            return ret;
        }, arguments); },
        __wbg_getPrototypeOf_7c8bfde858c0db4c: function(arg0) {
            const ret = Object.getPrototypeOf(arg0);
            return ret;
        },
        __wbg_getRandomValues_127d43fea0fcc894: function() { return handleError(function (arg0) {
            globalThis.crypto.getRandomValues(arg0);
        }, arguments); },
        __wbg_getTime_d6f070c088c9b5ed: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_getTimezoneOffset_dc9862c79e5a81a3: function(arg0) {
            const ret = arg0.getTimezoneOffset();
            return ret;
        },
        __wbg_get_4c9659eaf3eaf782: function(arg0, arg1) {
            const ret = arg0.get(arg1);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_507a50627bffa49b: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_5b0994f14acc7b27: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.get(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_a69966e97f233f79: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.get(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_get_c7eb1f358a7654df: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_grow_4860d0716dd2eb33: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.grow(arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_grow_510e6970b7b10d97: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.grow(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_hardwareConcurrency_94fd86e68bb941b9: function(arg0) {
            const ret = arg0.hardwareConcurrency;
            return ret;
        },
        __wbg_hardwareConcurrency_c9435647b41823d9: function(arg0) {
            const ret = arg0.hardwareConcurrency;
            return ret;
        },
        __wbg_has_8374cf06984d8bfc: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_7b59c5203c8c475d: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_headers_cf9c80f30e2a4eff: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_httpresponsecore_new: function(arg0) {
            const ret = HttpResponseCore.__wrap(arg0);
            return ret;
        },
        __wbg_id_62138633423b81dc: function(arg0) {
            const ret = arg0.id;
            return ret;
        },
        __wbg_id_6aecd57ba4038ade: function(arg0) {
            const ret = arg0.id;
            return ret;
        },
        __wbg_imports_8374e3583e124801: function(arg0) {
            const ret = WebAssembly.Module.imports(arg0);
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Cache_86e5408252b10cb9: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Cache;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Date_e54edffdcb007f5f: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Date;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Error_1fdac9f13a8181ba: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Error;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Function_5ab636d175047924: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Function;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Global_2c2df7a99c3b121b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebAssembly.Global;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Memory_2550e651acb3f2f1: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebAssembly.Memory;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Module_725d5acf76d9627e: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebAssembly.Module;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Object_33f20e6f12439f3e: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Object;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Promise_4cb210c0b8f8c959: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Promise;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_RangeError_7976f0547ad1279f: function(arg0) {
            let result;
            try {
                result = arg0 instanceof RangeError;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_c8b64b2256f01bec: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_SharedArrayBuffer_23468fe6287a6db3: function(arg0) {
            let result;
            try {
                result = arg0 instanceof SharedArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Table_4b4d507f81f7ae7c: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebAssembly.Table;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Tag_55f8841ad3b6e849: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebAssembly.Tag;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_05ba1ee4f6781663: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_WorkerGlobalScope_8ec07b5e040a41c3: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WorkerGlobalScope;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_04f36e4056f1b851: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_isView_efae9308a44fc593: function(arg0) {
            const ret = ArrayBuffer.isView(arg0);
            return ret;
        },
        __wbg_is_7b9d0b289033c7de: function(arg0, arg1) {
            const ret = Object.is(arg0, arg1);
            return ret;
        },
        __wbg_iterator_6f722e4a93058b71: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_keys_58421f8f96795607: function(arg0) {
            const ret = Object.keys(arg0);
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_81804e6c5f144937: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_lineno_670c4ab0f79a5b25: function(arg0) {
            const ret = arg0.lineno;
            return ret;
        },
        __wbg_load_209206003cdf5be2: function() { return handleError(function (arg0, arg1) {
            const ret = Atomics.load(arg0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_load_82be47ece90ce232: function() { return handleError(function (arg0, arg1) {
            const ret = Atomics.load(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_match_5403e213aa78598b: function(arg0, arg1, arg2) {
            const ret = arg0.match(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_message_8326fb1d549bebc5: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_message_f959e4f25c384966: function(arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_navigator_51379c10a84aeec9: function(arg0) {
            const ret = arg0.navigator;
            return ret;
        },
        __wbg_navigator_99621db14b3f1099: function(arg0) {
            const ret = arg0.navigator;
            return ret;
        },
        __wbg_new_04d90be913667d62: function(arg0) {
            const ret = new ArrayBuffer(arg0 >>> 0);
            return ret;
        },
        __wbg_new_064bad50902c47ca: function(arg0) {
            const ret = new WeakRef(arg0);
            return ret;
        },
        __wbg_new_0_3da9e97f24fc69be: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_199ffff4a1f16a85: function() { return handleError(function (arg0) {
            const ret = new WebAssembly.Tag(arg0);
            return ret;
        }, arguments); },
        __wbg_new_224fa49563952dc9: function(arg0) {
            const ret = new Int16Array(arg0);
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_2e0fce3def614b95: function(arg0) {
            const ret = new SharedArrayBuffer(arg0 >>> 0);
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_5e245ef5857d7f33: function(arg0, arg1) {
            const ret = new TypeError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_6355a538c1a2f582: function() {
            const ret = new WeakMap();
            return ret;
        },
        __wbg_new_691bb38c51ce2be6: function(arg0) {
            const ret = new BigInt64Array(arg0);
            return ret;
        },
        __wbg_new_6d3d7e359b2d786c: function(arg0, arg1) {
            const ret = new RangeError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_6eae9a77e2198212: function() { return handleError(function (arg0, arg1) {
            const ret = new WebAssembly.Global(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_new_70f79e80a78a1f78: function(arg0) {
            const ret = new Int32Array(arg0);
            return ret;
        },
        __wbg_new_711fb31c64c1c363: function() { return handleError(function (arg0) {
            const ret = new WebAssembly.Module(arg0);
            return ret;
        }, arguments); },
        __wbg_new_7837c9d3352daaa0: function() { return handleError(function (arg0) {
            const ret = new WebAssembly.Memory(arg0);
            return ret;
        }, arguments); },
        __wbg_new_8666afa1ea06ab6b: function() { return handleError(function (arg0) {
            const ret = new WebAssembly.Suspending(arg0);
            return ret;
        }, arguments); },
        __wbg_new_944c2b5ed6653041: function() { return handleError(function (arg0, arg1) {
            const ret = new WebAssembly.Instance(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_new_aec3e25493d729fe: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_b667d279fd5aa943: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_cc984128914cfc6f: function(arg0) {
            const ret = new Date(arg0);
            return ret;
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_eaabd7bd3b77a69c: function(arg0) {
            const ret = new Int8Array(arg0);
            return ret;
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_1824d93f294193e5: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_args_200d82645b6544eb: function(arg0, arg1, arg2, arg3) {
            const ret = new Function(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_new_with_byte_offset_and_length_54c7724ee3ec7d82: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_length_f8cbc3a5b9ff9368: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_opt_u8_array_14c47b6c15712e97: function() { return handleError(function (arg0, arg1) {
            const ret = new Response(arg0 === 0 ? undefined : getArrayU8FromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_new_with_options_6b48999e016c6fc6: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Worker(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_and_init_d95cbe11ce28e65e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_u8_array_sequence_and_options_2c1900e5a5c93850: function() { return handleError(function (arg0, arg1) {
            const ret = new Blob(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_new_with_value_6990dd0a8bc17691: function() { return handleError(function (arg0, arg1) {
            const ret = new WebAssembly.Table(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_new_worker_a37b91c84b1f9aa5: function(arg0, arg1) {
            const ret = new Worker(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_next_6dbf2c0ac8cde20f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_71f2aa1cb3d1e37e: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_notify_1edcdceac3728c69: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.notify(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_of_5f1b88183ddb5d94: function(arg0, arg1) {
            const ret = Array.of(arg0, arg1);
            return ret;
        },
        __wbg_of_b0cd2e09b31a9684: function(arg0, arg1, arg2) {
            const ret = Array.of(arg0, arg1, arg2);
            return ret;
        },
        __wbg_open_1ee80f2c655b05e9: function(arg0, arg1, arg2) {
            const ret = arg0.open(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_or_f077fae32523ac8f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.or(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_or_fcb77dffe98d540f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.or(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_outputcore_new: function(arg0) {
            const ret = OutputCore.__wrap(arg0);
            return ret;
        },
        __wbg_ownKeys_a2745e10effd5d46: function() { return handleError(function (arg0) {
            const ret = Reflect.ownKeys(arg0);
            return ret;
        }, arguments); },
        __wbg_packagecore_new: function(arg0) {
            const ret = PackageCore.__wrap(arg0);
            return ret;
        },
        __wbg_postMessage_56396682c54d5757: function() { return handleError(function (arg0, arg1) {
            arg0.postMessage(arg1);
        }, arguments); },
        __wbg_postMessage_ea8632bb43026d6a: function() { return handleError(function (arg0, arg1) {
            arg0.postMessage(arg1);
        }, arguments); },
        __wbg_postMessage_f48bc524bea113e2: function() { return handleError(function (arg0, arg1) {
            arg0.postMessage(arg1);
        }, arguments); },
        __wbg_processcore_new: function(arg0) {
            const ret = ProcessCore.__wrap(arg0);
            return ret;
        },
        __wbg_promising_8e527675e47b0c18: function() { return handleError(function (arg0) {
            const ret = WebAssembly.promising(arg0);
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_put_650ce93c775fde08: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.put(getStringFromWasm0(arg1, arg2), arg3);
            return ret;
        },
        __wbg_queueMicrotask_0ab5b2d2393e99b9: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_6a09b7bc46549209: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_random_039a7d5d06e0d333: function() {
            const ret = Math.random();
            return ret;
        },
        __wbg_redirected_ef8aef1710a452df: function(arg0) {
            const ret = arg0.redirected;
            return ret;
        },
        __wbg_reject_90df95b492dd8563: function(arg0) {
            const ret = Promise.reject(arg0);
            return ret;
        },
        __wbg_resolve_2191a4dfe481c25b: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_sandboxcore_new: function(arg0) {
            const ret = SandboxCore.__wrap(arg0);
            return ret;
        },
        __wbg_seal_2102d7a1c4a45e1e: function(arg0) {
            const ret = Object.seal(arg0);
            return ret;
        },
        __wbg_setPrototypeOf_fc3ecf1ff0ac6dc7: function(arg0, arg1) {
            const ret = Object.setPrototypeOf(arg0, arg1);
            return ret;
        },
        __wbg_setTimeout_6928223bf8fbd91a: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_setTimeout_cfa2cf195c3738db: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_setWakeCallback_6447644b7eed609f: function(arg0, arg1) {
            arg0.setWakeCallback(arg1);
        },
        __wbg_set_0de9c62c23d04ad5: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.set(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_set_3d37fcf5c11a6cdb: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_4d7dd76f3dae2926: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_61e45ae8061eca11: function(arg0, arg1, arg2) {
            arg0.set(arg1, arg2 >>> 0);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_body_029f2d171e0a005f: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_eeaf6f49bd2bf077: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.set(arg1 >>> 0, arg2);
        }, arguments); },
        __wbg_set_method_5532d59b92d76467: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_66c79886ad78fc05: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_name_3bbc583faefa4193: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_name_9ee85c4227217134: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_onerror_cc3a477eed014488: function(arg0, arg1) {
            arg0.onerror = arg1;
        },
        __wbg_set_onmessage_57d6a01ac0bfd3a3: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_onmessage_e3a42c9af9f677a1: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_type_8ce203e412e28cf6: function(arg0, arg1, arg2) {
            arg0.type = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_type_e30b9a6650be2f07: function(arg0, arg1) {
            arg0.type = __wbindgen_enum_WorkerType[arg1];
        },
        __wbg_set_value_f86d819107cb271b: function(arg0, arg1) {
            arg0.value = arg1;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_c45b3b9b3033184a: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_store_d936663b08dcfdea: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.store(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_store_f592c3523c645a48: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.store(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_sub_33247bb1ea08507d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.sub(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_sub_935ae32d3e4fb0d1: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.sub(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_terminate_13d19661bbbf7d2b: function(arg0) {
            arg0.terminate();
        },
        __wbg_then_16d107c451e9905d: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_6ec10ae38b3e92f7: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_then_e0960b859f3ff223: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_toString_6a94911348396720: function(arg0, arg1, arg2) {
            const ret = arg1.toString(arg2);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg_toString_b201c2690bbe445a: function(arg0) {
            const ret = arg0.toString();
            return ret;
        },
        __wbg_trap_new: function(arg0) {
            const ret = Trap.__wrap(arg0);
            return ret;
        },
        __wbg_validate_2bf76e0e61374b8e: function() { return handleError(function (arg0) {
            const ret = WebAssembly.validate(arg0);
            return ret;
        }, arguments); },
        __wbg_value_5bf3641a3c74fb47: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_value_99213de42db60201: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_value_a5d5488a9589444a: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_waitAsync_06c45f5361ba204a: function() {
            const ret = Atomics.waitAsync;
            return ret;
        },
        __wbg_waitAsync_919777b30820ea59: function(arg0, arg1, arg2) {
            const ret = Atomics.waitAsync(arg0, arg1 >>> 0, arg2);
            return ret;
        },
        __wbg_wait_55efa0baf937c96d: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = Atomics.wait(arg0, arg1 >>> 0, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_wait_6e0004d18f12deb4: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = Atomics.wait(arg0, arg1 >>> 0, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_buffer_view_b77c771ca459febb: function(arg0, arg1, arg2) {
            const ret = wasmer_napi_buffer_view(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_wasmer_napi_compile_function_cf5f1a6b4bde3f7a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            const ret = wasmer_napi_compile_function(arg0, arg1, arg2, getStringFromWasm0(arg3, arg4), getStringFromWasm0(arg5, arg6));
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_compile_module_88f760e7135b4f9d: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = wasmer_napi_compile_module(arg0, getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_console_error_f46fb42dccf59767: function(arg0, arg1) {
            wasmer_napi_console_error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_wasmer_napi_context_eval_5278daf2797bde11: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = wasmer_napi_context_eval(arg0, getStringFromWasm0(arg1, arg2));
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_create_serdes_binding_f1479a596a13dd53: function() { return handleError(function () {
            const ret = wasmer_napi_create_serdes_binding();
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_event_loop_checkpoint_d2ad812273c7fc98: function(arg0, arg1) {
            const ret = wasmer_napi_event_loop_checkpoint(arg0 !== 0, arg1 !== 0);
            return ret;
        },
        __wbg_wasmer_napi_get_all_property_names_3905082a4149a0bd: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = wasmer_napi_get_all_property_names(arg0, arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_number_e96c68c4727cc94f: function() { return handleError(function (arg0) {
            const ret = wasmer_napi_number(arg0);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_obtain_message_eaf1ce445b037d46: function() { return handleError(function (arg0) {
            const ret = wasmer_napi_obtain_message(arg0 >>> 0);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_release_message_7403da83c786d13a: function(arg0) {
            wasmer_napi_release_message(arg0 >>> 0);
        },
        __wbg_wasmer_napi_share_message_60d9583b21f9b173: function() { return handleError(function (arg0, arg1) {
            const ret = wasmer_napi_share_message(arg0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_string_862fbc3db2f478a9: function() { return handleError(function (arg0) {
            const ret = wasmer_napi_string(arg0);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_structured_clone_0bc5e2f7ca95a395: function() { return handleError(function (arg0, arg1) {
            const ret = wasmer_napi_structured_clone(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_typed_array_336a9ba330e27049: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = wasmer_napi_typed_array(arg0, arg1, arg2 >>> 0, arg3 >>> 0);
            return ret;
        }, arguments); },
        __wbg_wasmer_napi_validate_script_d7a022823d506ba6: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            wasmer_napi_validate_script(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
        }, arguments); },
        __wbg_wasmer_napi_wait_for_message_00d65d5d8d823042: function(arg0) {
            const ret = wasmer_napi_wait_for_message(arg0 >>> 0);
            return ret;
        },
        __wbg_xor_801affcaa3585533: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.xor(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbg_xor_eb844d9d010c9011: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Atomics.xor(arg0, arg1 >>> 0, arg2);
            return ret;
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref, NamedExternref("Array<any>")], shim_idx: 1893, ret: Externref, inner_ret: Some(Externref) }, mutable: false }) -> Externref`.
            const ret = makeClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__true_);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 4252, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue______true_);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 5716, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsError___true_);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 5718, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___futures__task__wait_async_polyfill__MessageEvent______true_);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("ErrorEvent")], shim_idx: 14, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true_);
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 14, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true__5);
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Ref(NamedExternref("Array<any>"))], shim_idx: 2432, ret: NamedExternref("Promise<any>"), inner_ret: Some(NamedExternref("Promise<any>")) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__js_sys_58c106928725dc10___Promise__true_);
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Ref(NamedExternref("Array<any>"))], shim_idx: 2462, ret: Result(Externref), inner_ret: Some(Result(Externref)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Ref(NamedExternref("Array<any>"))], shim_idx: 2462, ret: Result(NamedExternref("Array<any>")), inner_ret: Some(Result(NamedExternref("Array<any>"))) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true__8);
            return ret;
        },
        __wbindgen_cast_000000000000000a: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Ref(NamedExternref("Array<any>"))], shim_idx: 2464, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_);
            return ret;
        },
        __wbindgen_cast_000000000000000b: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [U32, String], shim_idx: 17, ret: Boolean, inner_ret: Some(Boolean) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___u32__alloc_7c34f695827b06d3___string__String__bool__true_);
            return ret;
        },
        __wbindgen_cast_000000000000000c: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_000000000000000d: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_000000000000000e: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000f: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000010: function(arg0, arg1) {
            // Cast intrinsic for `U128 -> Externref`.
            const ret = (BigInt.asUintN(64, arg0) | (BigInt.asUintN(64, arg1) << BigInt(64)));
            return ret;
        },
        __wbindgen_cast_0000000000000011: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_cast_0000000000000012: function(arg0, arg1) {
            var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 4, 4);
            // Cast intrinsic for `Vector(NamedExternref("string")) -> Externref`.
            const ret = v0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
        __wbindgen_link_580560c8bba509f2: function(arg0) {
            const val = `onmessage = function (ev) {
                let [ia, index, value] = ev.data;
                ia = new Int32Array(ia.buffer);
                let result = Atomics.wait(ia, index, value);
                postMessage(result);
            };
            `;
            const ret = typeof URL.createObjectURL === 'undefined' ? "data:application/javascript," + encodeURIComponent(val) : URL.createObjectURL(new Blob([val], { type: "text/javascript" }));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        memory: memory || new WebAssembly.Memory({initial:25,maximum:65536,shared:true}),
    };
    return {
        __proto__: null,
        "./wasmer_sdk_js_bg.js": import0,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import1,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import2,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import3,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import4,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import5,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import6,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import7,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import8,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import9,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import10,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import11,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import12,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import13,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import14,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import15,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import16,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import17,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import18,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import19,
        "./snippets/wasmer-napi-4dc421676e010b84/inline0.js": import20,
    };
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue______true_(arg0, arg1, arg2);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___futures__task__wait_async_polyfill__MessageEvent______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___futures__task__wait_async_polyfill__MessageEvent______true_(arg0, arg1, arg2);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true_(arg0, arg1, arg2);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true__5(arg0, arg1, arg2) {
    wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___web_sys_aa4a58e1f891e00a___features__gen_ErrorEvent__ErrorEvent______true__5(arg0, arg1, arg2);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__js_sys_58c106928725dc10___Promise__true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__js_sys_58c106928725dc10___Promise__true_(arg0, arg1, arg2);
    return ret;
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_____wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true_(arg0, arg1, arg2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true__8(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures________invoke___js_sys_58c106928725dc10___Array__core_5c1d373054d6af5a___result__Result_js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue___true__8(arg0, arg1, arg2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined___js_sys_58c106928725dc10___Function_fn_wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue_____wasm_bindgen_3b7ec0c2bfb9e0c6___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__true_(arg0, arg1, arg2, arg3) {
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__js_sys_58c106928725dc10___Array__wasm_bindgen_3b7ec0c2bfb9e0c6___JsValue__true_(arg0, arg1, arg2, arg3);
    return ret;
}

function wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___u32__alloc_7c34f695827b06d3___string__String__bool__true_(arg0, arg1, arg2, arg3) {
    const ptr0 = passStringToWasm0(arg3, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasm_bindgen_3b7ec0c2bfb9e0c6___convert__closures_____invoke___u32__alloc_7c34f695827b06d3___string__String__bool__true_(arg0, arg1, arg2, ptr0, len0);
    return ret !== 0;
}


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];


const __wbindgen_enum_WorkerType = ["classic", "module"];
const CommandCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_commandcore_free(ptr, 1));
const HttpResponseCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_httpresponsecore_free(ptr, 1));
const OutputCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_outputcore_free(ptr, 1));
const PackageCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packagecore_free(ptr, 1));
const ProcessCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processcore_free(ptr, 1));
const SandboxBuilderCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sandboxbuildercore_free(ptr, 1));
const SandboxCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sandboxcore_free(ptr, 1));
const ThreadPoolWorkerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_threadpoolworker_free(ptr, 1));
const TrapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_trap_free(ptr, 1));
const WasmerCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmercore_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer || cachedDataViewMemory0.byteLength !== wasm.memory.buffer.byteLength) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.buffer !== wasm.memory.buffer || cachedUint16ArrayMemory0.byteLength !== wasm.memory.buffer.byteLength) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer || cachedUint8ArrayMemory0.byteLength !== wasm.memory.buffer.byteLength) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        try {
            return f(state.a, state.b, ...args);
        } finally {
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined);

if (cachedTextEncoder) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw new Error('invalid stack size');
    }

    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasmer_sdk_js_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };
