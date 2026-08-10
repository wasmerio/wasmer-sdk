use std::{
    fmt::{Debug, Display},
    num::NonZeroUsize,
};

use js_sys::{Array, Function, JsString, Promise};

use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};
use web_sys::{Window, WorkerGlobalScope};

#[wasm_bindgen(inline_js = r#"
const wasmerSdkHostSetTimeout = globalThis.setTimeout.bind(globalThis);
const wasmerSdkHostClearTimeout = globalThis.clearTimeout.bind(globalThis);
const wasmerSdkHostPromise = globalThis.Promise;

export function wasmer_sdk_create_host_timer(milliseconds) {
  let active = true;
  let handle;
  let resolveTimer;
  const promise = new wasmerSdkHostPromise((resolve) => {
    resolveTimer = resolve;
    handle = wasmerSdkHostSetTimeout(() => {
      if (!active) return;
      active = false;
      resolve();
    }, milliseconds);
  });
  const cancel = () => {
    if (!active) return;
    active = false;
    wasmerSdkHostClearTimeout(handle);
    resolveTimer();
  };
  return [promise, cancel];
}
"#)]
extern "C" {
    fn wasmer_sdk_create_host_timer(milliseconds: i32) -> Array;
}

pub(crate) struct HostTimer {
    promise: Promise,
    cancel: Function,
}

impl HostTimer {
    pub(crate) fn new(milliseconds: i32) -> Self {
        let timer = wasmer_sdk_create_host_timer(milliseconds);
        Self {
            promise: timer.get(0).unchecked_into(),
            cancel: timer.get(1).unchecked_into(),
        }
    }

    pub(crate) fn promise(&self) -> Promise {
        self.promise.clone()
    }

    pub(crate) fn cancel(&self) {
        let _ = self.cancel.call0(&JsValue::UNDEFINED);
    }
}

impl Drop for HostTimer {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Try to extract the most appropriate error message from a [`JsValue`],
/// falling back to a generic error message.
pub(crate) fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(e) = value.dyn_ref::<js_sys::Error>() {
        anyhow::Error::msg(String::from(e.message()))
    } else if let Some(obj) = value.dyn_ref::<js_sys::Object>() {
        return anyhow::Error::msg(String::from(obj.to_string()));
    } else if let Some(s) = value.dyn_ref::<js_sys::JsString>() {
        return anyhow::Error::msg(String::from(s));
    } else {
        anyhow::anyhow!("An unknown error occurred: {value:?}")
    }
}

/// A strongly-typed wrapper around `globalThis`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum GlobalScope {
    Window(Window),
    Worker(WorkerGlobalScope),
    Other(js_sys::Object),
}

impl GlobalScope {
    pub fn current() -> Self {
        let global_scope = js_sys::global();

        match global_scope.dyn_into() {
            Ok(window) => GlobalScope::Window(window),
            Err(global_scope) => match global_scope.dyn_into() {
                Ok(worker_global_scope) => GlobalScope::Worker(worker_global_scope),
                Err(other) => GlobalScope::Other(other),
            },
        }
    }

    pub fn sleep(&self, milliseconds: i32) -> Promise {
        Promise::new(&mut |resolve, reject| match self {
            GlobalScope::Window(window) => {
                window
                    .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
                    .unwrap();
            }
            GlobalScope::Worker(worker_global_scope) => {
                worker_global_scope
                    .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
                    .unwrap();
            }
            GlobalScope::Other(global) => {
                match js_sys::Reflect::get(global, &JsValue::from_str("setTimeout"))
                    .ok()
                    .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
                {
                    Some(set_timeout) => {
                        let _ = set_timeout.call2(global, &resolve, &milliseconds.into());
                    }
                    None => {
                        let error = js_sys::Error::new("Unable to call setTimeout()");
                        reject.call1(&reject, &error).unwrap();
                    }
                }
            }
        })
    }

    /// The amount of concurrency available on this system.
    ///
    /// Returns `None` if unable to determine the available concurrency.
    pub fn hardware_concurrency(&self) -> Option<NonZeroUsize> {
        let concurrency = match self {
            GlobalScope::Window(scope) => scope.navigator().hardware_concurrency(),
            GlobalScope::Worker(scope) => scope.navigator().hardware_concurrency(),
            GlobalScope::Other(scope) => {
                return js_sys::Reflect::get(scope, &JsValue::from_str("navigator"))
                    .ok()
                    .and_then(|navigator| {
                        js_sys::Reflect::get(&navigator, &JsValue::from_str("hardwareConcurrency"))
                            .ok()
                    })
                    .and_then(|value| value.as_f64())
                    .and_then(|value| NonZeroUsize::new(value.round() as usize));
            }
        };

        let concurrency = concurrency.round() as usize;
        NonZeroUsize::new(concurrency)
    }

    pub fn cross_origin_isolated(&self) -> Option<bool> {
        let obj = self.as_object();
        js_sys::Reflect::get(obj, &JsValue::from_str("crossOriginIsolated"))
            .ok()
            .and_then(|obj| obj.as_bool())
    }

    fn as_object(&self) -> &js_sys::Object {
        match self {
            GlobalScope::Window(w) => w,
            GlobalScope::Worker(w) => w,
            GlobalScope::Other(obj) => obj,
        }
    }
}

/// A wrapper around [`anyhow::Error`] that can be returned to JS to raise
/// an exception.
#[derive(Debug)]
pub enum Error {
    Rust(anyhow::Error),
    JavaScript(JsValue),
}

impl Error {
    pub(crate) fn js(error: impl Into<JsValue>) -> Self {
        Error::JavaScript(error.into())
    }

    pub(crate) fn into_anyhow(self) -> anyhow::Error {
        match self {
            Error::Rust(e) => e,
            Error::JavaScript(js) => js_error(js),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(value: E) -> Self {
        Error::Rust(value.into())
    }
}

impl From<Error> for JsValue {
    fn from(error: Error) -> Self {
        match error {
            Error::JavaScript(e) => e,
            Error::Rust(error) => {
                let message = format!("{error:#}");
                let js_error = js_sys::Error::new(&message);

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("message"),
                    &JsString::from(message),
                );

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("detailedMessage"),
                    &JsString::from(format!("{error:?}")),
                );

                let causes: js_sys::Array = std::iter::successors(error.source(), |e| e.source())
                    .map(|e| JsString::from(e.to_string()))
                    .collect();
                let _ = js_sys::Reflect::set(&js_error, &JsString::from("causes"), &causes);

                js_error.into()
            }
        }
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Rust(e) => Display::fmt(e, f),
            Error::JavaScript(js) => {
                if let Some(e) = js.dyn_ref::<js_sys::Error>() {
                    write!(f, "{}", String::from(e.message()))
                } else if let Some(obj) = js.dyn_ref::<js_sys::Object>() {
                    write!(f, "{}", String::from(obj.to_string()))
                } else if let Some(s) = js.dyn_ref::<js_sys::JsString>() {
                    write!(f, "{}", String::from(s))
                } else {
                    write!(f, "A JavaScript error occurred")
                }
            }
        }
    }
}

pub(crate) fn hidden<T>(_value: T, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("_")
}

/// Get a reference to the currently running module.
pub(crate) fn current_module() -> js_sys::WebAssembly::Module {
    // FIXME: Switch this to something stable and portable
    //
    // We use an undocumented API to get a reference to the
    // WebAssembly module that is being executed right now so start
    // a new thread by transferring the WebAssembly linear memory and
    // module to a worker and beginning execution.
    //
    // This can only be used in the browser. Trying to build
    // wasmer-wasix for NodeJS will probably result in the following:
    //
    // Error: executing `wasm-bindgen` over the wasm file
    //   Caused by:
    //   0: failed to generate bindings for import of `__wbindgen_placeholder__::__wbindgen_module`
    //   1: `wasm_bindgen::module` is currently only supported with `--target no-modules` and `--tar get web`
    wasm_bindgen::module().dyn_into().unwrap()
}

pub(crate) fn module_hash_from_hex(value: &str) -> Result<wasmer_types::ModuleHash, Error> {
    if value.len() != 64 {
        return Err(anyhow::anyhow!("invalid module hash length").into());
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let offset = index * 2;
        *byte = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|error| anyhow::anyhow!("invalid module hash: {error}"))?;
    }
    Ok(wasmer_types::ModuleHash::from_bytes(bytes))
}
