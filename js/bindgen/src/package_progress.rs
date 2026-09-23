use js_sys::{Array, Function, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasmer_sdk::{PackageLoadOptions, PackageLoadProgress, PackageSource};

use crate::{JsPackage, JsWasmer, custom_error, sdk_error};

#[wasm_bindgen(js_name = PackageLoadCancellation)]
pub struct JsPackageLoadCancellation {
    inner: wasmer_sdk::PackageLoadCancellation,
}

#[wasm_bindgen(js_class = PackageLoadCancellation)]
impl JsPackageLoadCancellation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Default::default(),
        }
    }
    pub fn cancel(&self) {
        self.inner.cancel();
    }
}

fn deliver(callback: &mut Option<Function>, progress: PackageLoadProgress) {
    let Some(function) = callback.as_ref() else {
        return;
    };
    let safe = |p: &wasmer_sdk::DownloadProgress| {
        p.downloaded_bytes <= 9_007_199_254_740_991
            && p.total_bytes.is_none_or(|n| n <= 9_007_199_254_740_991)
    };
    let result =
        if !safe(&progress.download) || progress.packages.iter().any(|p| !safe(&p.download)) {
            Err(custom_error(
                "INVALID_ARGUMENT",
                "Progress byte count exceeds JavaScript's exact integer range",
            ))
        } else {
            progress
                .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
                .map_err(JsValue::from)
                .and_then(|value| function.call1(&JsValue::UNDEFINED, &value))
        };
    if let Err(error) = result {
        web_sys::console::error_1(&error);
        *callback = None;
    }
}

#[wasm_bindgen(js_class = WasmerCore)]
impl JsWasmer {
    #[wasm_bindgen(js_name = loadPackages)]
    pub async fn load_packages(
        &self,
        sources: Array,
        mut callback: Option<Function>,
        cancellation: &JsPackageLoadCancellation,
    ) -> Result<Array, JsValue> {
        let sources: Vec<_> = sources
            .iter()
            .map(|source| {
                if let Some(specifier) = source.as_string() {
                    Ok(PackageSource::Registry(specifier))
                } else if source.is_instance_of::<Uint8Array>() {
                    Ok(PackageSource::Bytes(
                        source.unchecked_into::<Uint8Array>().to_vec().into(),
                    ))
                } else {
                    Err(custom_error(
                        "INVALID_PACKAGE_SOURCE",
                        "Expected a registry string or Uint8Array",
                    ))
                }
            })
            .collect::<Result<_, _>>()?;
        let mut options = PackageLoadOptions::default().cancellation(cancellation.inner.clone());
        let (sender, mut progress) = tokio::sync::watch::channel(None);
        if callback.is_some() {
            options = options.on_progress(move |update| {
                sender.send_replace(Some(update));
            });
        }
        let load = self.inner.packages();
        let load = load.load_many_with_options(sources, options);
        tokio::pin!(load);
        loop {
            tokio::select! {
                result = &mut load => {
                    if let Some(update) = progress.borrow_and_update().clone() { deliver(&mut callback, update); }
                    let packages = result.map_err(sdk_error)?;
                    return Ok(packages.into_iter().map(|inner| JsValue::from(JsPackage { inner })).collect());
                }
                changed = progress.changed(), if callback.is_some() => {
                    if changed.is_ok() {
                        if let Some(update) = progress.borrow_and_update().clone() { deliver(&mut callback, update); }
                    } else { callback = None; }
                }
            }
        }
    }
}
