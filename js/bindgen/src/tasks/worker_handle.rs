use std::fmt::Debug;

use anyhow::{Context, Error};
use js_sys::{Array, JsString, Uint8Array};
use once_cell::sync::Lazy;
use wasm_bindgen::{JsCast, JsValue, prelude::Closure};

use crate::tasks::{PostMessagePayload, Scheduler, SchedulerMessage, WorkerMessage};

#[derive(Clone, Debug)]
pub(crate) struct CapiTransfer {
    pub(crate) registry_id: u32,
    pub(crate) handle: i32,
    pub(crate) value: JsValue,
}

/// A handle to a running [`web_sys::Worker`].
///
/// This provides a structured way to communicate with the worker and will
/// automatically call [`web_sys::Worker::terminate()`] when dropped.
#[derive(Debug)]
pub(crate) struct WorkerHandle {
    id: u32,
    inner: web_sys::Worker,
}

impl WorkerHandle {
    pub(crate) fn spawn(worker_id: u32, sender: Scheduler) -> Result<Self, Error> {
        let name = format!("worker-{worker_id}");

        let worker_url = worker_url();
        let options = web_sys::WorkerOptions::new();
        options.set_name(&name);
        options.set_type(web_sys::WorkerType::Module);
        let worker = web_sys::Worker::new_with_options(&worker_url, &options)
            .map_err(crate::worker_utils::js_error)?;

        let on_message: Closure<dyn FnMut(web_sys::MessageEvent)> = Closure::new({
            let sender = sender.clone();
            move |msg: web_sys::MessageEvent| {
                on_message(msg, &sender, worker_id);
            }
        });
        let on_message: js_sys::Function = on_message.into_js_value().unchecked_into();
        worker.set_onmessage(Some(&on_message));

        let on_error: Closure<dyn FnMut(web_sys::ErrorEvent)> =
            Closure::new(move |msg| on_error(msg, worker_id));
        let on_error: js_sys::Function = on_error.into_js_value().unchecked_into();
        worker.set_onerror(Some(&on_error));

        // The worker has technically been started, but it's kinda useless
        // because it hasn't been initialized with the same WebAssembly module
        // and linear memory as the scheduler. We need to initialize explicitly.
        init_message(worker_id)
            .and_then(|msg| worker.post_message(&msg))
            .map_err(crate::worker_utils::js_error)?;

        Ok(WorkerHandle {
            id: worker_id,
            inner: worker,
        })
    }

    pub(crate) fn id(&self) -> u32 {
        self.id
    }

    /// Send a message to the worker.
    pub(crate) fn send(&self, msg: PostMessagePayload) -> Result<(), Error> {
        self.send_with_capi_transfers(msg, Vec::new())
    }

    /// Send a task and make its nested WebAssembly objects available before
    /// the worker starts executing it.
    pub(crate) fn send_with_capi_transfers(
        &self,
        msg: PostMessagePayload,
        transfers: Vec<CapiTransfer>,
    ) -> Result<(), Error> {
        tracing::trace!(?msg, worker.id = self.id(), "sending a message to a worker");
        let payload = msg.into_js().map_err(|e| e.into_anyhow())?;
        let js = if transfers.is_empty() {
            payload
        } else {
            capi_dispatch_message(payload, transfers)?
        };

        self.inner
            .post_message(&js)
            .map_err(crate::worker_utils::js_error)?;

        Ok(())
    }
}

fn capi_dispatch_message(payload: JsValue, transfers: Vec<CapiTransfer>) -> Result<JsValue, Error> {
    let objects = Array::new();
    for transfer in transfers {
        let object = js_sys::Object::new();
        js_sys::Reflect::set(
            &object,
            &JsValue::from_str("registryId"),
            &JsValue::from(transfer.registry_id),
        )
        .map_err(crate::worker_utils::js_error)?;
        js_sys::Reflect::set(
            &object,
            &JsValue::from_str("handle"),
            &JsValue::from(transfer.handle),
        )
        .map_err(crate::worker_utils::js_error)?;
        js_sys::Reflect::set(&object, &JsValue::from_str("value"), &transfer.value)
            .map_err(crate::worker_utils::js_error)?;
        objects.push(&object);
    }

    let message = js_sys::Object::new();
    js_sys::Reflect::set(
        &message,
        &JsValue::from_str("type"),
        &JsValue::from_str("wasmer-dispatch"),
    )
    .map_err(crate::worker_utils::js_error)?;
    js_sys::Reflect::set(&message, &JsValue::from_str("payload"), &payload)
        .map_err(crate::worker_utils::js_error)?;
    js_sys::Reflect::set(&message, &JsValue::from_str("capiObjects"), &objects)
        .map_err(crate::worker_utils::js_error)?;
    Ok(message.into())
}

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    fn capi_objects_are_attached_to_the_worker_dispatch() {
        let payload = js_sys::Object::new();
        let message = capi_dispatch_message(
            payload.clone().into(),
            vec![CapiTransfer {
                registry_id: 7,
                handle: 11,
                value: JsValue::from_str("module"),
            }],
        )
        .unwrap();

        assert_eq!(
            js_sys::Reflect::get(&message, &JsValue::from_str("type"))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("wasmer-dispatch")
        );
        assert!(js_sys::Object::is(
            &js_sys::Reflect::get(&message, &JsValue::from_str("payload")).unwrap(),
            &payload,
        ));
        let objects = js_sys::Array::from(
            &js_sys::Reflect::get(&message, &JsValue::from_str("capiObjects")).unwrap(),
        );
        assert_eq!(objects.length(), 1);
        assert_eq!(
            js_sys::Reflect::get(&objects.get(0), &JsValue::from_str("handle"))
                .unwrap()
                .as_f64(),
            Some(11.0)
        );
    }
}

#[tracing::instrument(level = "trace", skip_all, fields(worker.id=worker_id))]
fn on_error(msg: web_sys::ErrorEvent, worker_id: u32) {
    tracing::error!(
        error = %msg.message(),
        filename = %msg.filename(),
        line_number = %msg.lineno(),
        column = %msg.colno(),
        "An error occurred",
    );
}

#[tracing::instrument(level = "trace", skip_all, fields(worker.id=worker_id))]
fn on_message(msg: web_sys::MessageEvent, sender: &Scheduler, worker_id: u32) {
    if handle_capi_share(&msg.data(), sender, worker_id) {
        return;
    }
    if handle_capi_delete(&msg.data(), sender, worker_id) {
        return;
    }
    if handle_host_rpc(&msg.data()) {
        return;
    }

    // Safety: The only way we can receive this message is if it was from the
    // worker, because we are the ones that spawned the worker, we can trust
    // the messages it emits.
    let result = unsafe { WorkerMessage::try_from_js(msg.data()) }
        .map_err(|e| crate::worker_utils::js_error(e.into()))
        .context("Unable to parse the worker message")
        .and_then(|base_msg| {
            tracing::trace!(
                ?base_msg,
                worker.id = worker_id,
                "Received a message from worker"
            );

            if sender.is_closed() && matches!(&base_msg, WorkerMessage::MarkIdle) {
                tracing::warn!("Scheduler is closed, dropping message {:?}", msg);
                return Ok(());
            }

            let msg = match base_msg {
                WorkerMessage::MarkBusy => SchedulerMessage::WorkerBusy { worker_id },
                WorkerMessage::MarkIdle => SchedulerMessage::WorkerIdle { worker_id },
                WorkerMessage::Scheduler(msg) => SchedulerMessage::FromWorker {
                    source_worker_id: worker_id,
                    message: Box::new(msg),
                },
            };
            sender.send(msg).map_err(|_| Error::msg("Send failed"))
        });

    if let Err(e) = result {
        tracing::warn!(
            error = &*e,
            // msg.origin = msg.origin(),
            // msg.last_event_id = msg.last_event_id(),
            "Unable to handle a message from the worker",
        );
    }
}

fn handle_capi_share(data: &JsValue, sender: &Scheduler, worker_id: u32) -> bool {
    let get = |name: &str| js_sys::Reflect::get(data, &JsValue::from_str(name)).ok();
    if get("type").and_then(|value| value.as_string()).as_deref() != Some("wasmer-capi-share") {
        return false;
    }
    let Some(registry_id) = get("registryId").and_then(|value| value.as_f64()) else {
        return true;
    };
    let Some(handle) = get("handle").and_then(|value| value.as_f64()) else {
        return true;
    };
    let Some(value) = get("value") else {
        return true;
    };
    if let Err(error) = sender.send(SchedulerMessage::CapiShare {
        source_worker_id: worker_id,
        registry_id: registry_id as u32,
        handle: handle as i32,
        value,
    }) {
        tracing::warn!(%error, "Unable to publish nested WebAssembly object");
    }
    true
}

fn handle_capi_delete(data: &JsValue, sender: &Scheduler, worker_id: u32) -> bool {
    let get = |name: &str| js_sys::Reflect::get(data, &JsValue::from_str(name)).ok();
    if get("type").and_then(|value| value.as_string()).as_deref() != Some("wasmer-capi-delete") {
        return false;
    }
    let Some(registry_id) = get("registryId").and_then(|value| value.as_f64()) else {
        return true;
    };
    let Some(handle) = get("handle").and_then(|value| value.as_f64()) else {
        return true;
    };
    if let Err(error) = sender.send(SchedulerMessage::CapiDelete {
        source_worker_id: worker_id,
        registry_id: registry_id as u32,
        handle: handle as i32,
    }) {
        tracing::warn!(%error, "Unable to release nested WebAssembly object");
    }
    true
}

/// Give the JavaScript facade first refusal for host-service RPC messages.
/// Browser networking uses this to keep the WISP connection on the main
/// thread while a WASIX process blocks inside a worker.
fn handle_host_rpc(data: &JsValue) -> bool {
    let global = js_sys::global();
    let Ok(handler) = js_sys::Reflect::get(&global, &JsValue::from_str("__wasmerHandleNetworkRpc"))
    else {
        return false;
    };
    let Some(handler) = handler.dyn_ref::<js_sys::Function>() else {
        return false;
    };
    handler
        .call1(&global, data)
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        tracing::debug!(id = self.id(), "Terminating worker");
        self.inner.terminate();
    }
}

/// Craft the special `"init"` message.
fn init_message(id: u32) -> Result<JsValue, JsValue> {
    let msg = js_sys::Object::new();

    js_sys::Reflect::set(&msg, &JsString::from("type"), &JsString::from("init"))?;
    js_sys::Reflect::set(&msg, &JsString::from("memory"), &wasm_bindgen::memory())?;
    js_sys::Reflect::set(&msg, &JsString::from("id"), &JsValue::from(id))?;
    js_sys::Reflect::set(&msg, &JsString::from("sdkUrl"), &JsValue::from(sdk_url()))?;
    js_sys::Reflect::set(
        &msg,
        &JsString::from("module"),
        &crate::worker_utils::current_module(),
    )?;

    Ok(msg.into())
}

// fn import_meta_url() -> String {
//     #[wasm_bindgen]
//     #[allow(non_snake_case)]
//     extern "C" {
//         #[wasm_bindgen(js_namespace = ["import", "meta"], js_name = url)]
//         static IMPORT_META_URL: String;
//     }

//     IMPORT_META_URL.to_string()
// }

/// The URL used by the bootstrapping script to import the Wasmer SDK.
fn sdk_url() -> String {
    let sdk_url = crate::CUSTOM_SDK_URL.lock().unwrap();
    // let import_meta_url = import_meta_url();
    let sdk_url = sdk_url.as_deref().unwrap_or("index.mjs");

    sdk_url.to_string()
}

/// The URL user for the worker.
fn worker_url() -> String {
    let worker_url = crate::CUSTOM_WORKER_URL.lock().unwrap();
    let worker_url = worker_url.as_deref().unwrap_or(DEFAULT_WORKER_URL.as_str());

    worker_url.to_string()
}

/// A data URL containing our worker's bootstrap script.
static DEFAULT_WORKER_URL: Lazy<String> = Lazy::new(|| {
    let script = include_str!("../../src-js/worker.js");
    let options = web_sys::BlobPropertyBag::new();
    options.set_type("application/javascript");

    let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(
        Array::from_iter([Uint8Array::from(script.as_bytes())]).as_ref(),
        &options,
    )
    .unwrap();

    web_sys::Url::create_object_url_with_blob(&blob).unwrap_or("worker.mjs".to_string())
});
