use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use wasmer_sdk::{PackageLoadOptions, PackageLoadProgress, PackageSource};

/// Raw module bytes as a package source, with their SHA-256 from the host's
/// native digest when it has one. A large module hashed by the SDK's own
/// Wasm takes about a second on a fresh instance (its one long call runs
/// unoptimized); SubtleCrypto takes tens of milliseconds. Without it, or if
/// it fails, the core hashes the module itself, once. A cancellation ends
/// the wait for the digest.
struct ModuleSnapshot {
    bytes: Vec<u8>,
    digest: Option<JsFuture>,
}

fn snapshot_module(bytes: Uint8Array) -> ModuleSnapshot {
    let magic = bytes.length() >= 4 && bytes.subarray(0, 4).to_vec() == b"\0asm";
    // digest() copies its input before returning, and the copy below runs
    // in the same turn: both see the same bytes.
    let digest = magic
        .then(|| start_digest(&bytes))
        .flatten()
        .map(JsFuture::from);
    ModuleSnapshot {
        bytes: bytes.to_vec(),
        digest,
    }
}

async fn module_source(
    snapshot: ModuleSnapshot,
    cancellation: &wasmer_sdk::PackageLoadCancellation,
) -> PackageSource {
    if let Some(pending) = snapshot.digest {
        let result = tokio::select! {
            result = pending => result,
            () = cancellation.cancelled() => Err(JsValue::UNDEFINED),
        };
        if let Ok(result) = result
            && result.is_instance_of::<js_sys::ArrayBuffer>()
        {
            let digest = Uint8Array::new(&result);
            if digest.length() == 32 {
                let mut sha256 = [0_u8; 32];
                digest.copy_to(&mut sha256);
                return PackageSource::wasm_module(snapshot.bytes, sha256);
            }
        }
    }
    PackageSource::Bytes(snapshot.bytes.into())
}

fn start_digest(bytes: &Uint8Array) -> Option<Promise> {
    // Nauta's crypto.subtle getter throws outside a secure context.
    let crypto = Reflect::get(&js_sys::global(), &"crypto".into()).ok()?;
    let subtle = Reflect::get(&crypto, &"subtle".into()).ok()?;
    let digest = Reflect::get(&subtle, &"digest".into())
        .ok()?
        .dyn_into::<Function>()
        .ok()?;
    digest
        .call2(&subtle, &"SHA-256".into(), bytes)
        .ok()?
        .dyn_into::<Promise>()
        .ok()
}

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
        enum Checked {
            Registry(String),
            Bytes(Uint8Array),
        }
        // Every source is checked before any is read.
        let checked: Vec<_> = sources
            .iter()
            .map(|source| {
                if let Some(specifier) = source.as_string() {
                    Ok(Checked::Registry(specifier))
                } else if source.is_instance_of::<Uint8Array>() {
                    Ok(Checked::Bytes(source.unchecked_into::<Uint8Array>()))
                } else {
                    Err(custom_error(
                        "INVALID_PACKAGE_SOURCE",
                        "Expected a registry string or Uint8Array",
                    ))
                }
            })
            .collect::<Result<_, _>>()?;
        enum Snapshot {
            Registry(String),
            Module(ModuleSnapshot),
        }
        // Snapshot the entire batch before waiting for any digest. Each
        // JsFuture attaches rejection handlers immediately, including for
        // later batch entries whose digest has not yet been awaited.
        let snapshots: Vec<_> = checked
            .into_iter()
            .map(|source| match source {
                Checked::Registry(value) => Snapshot::Registry(value),
                Checked::Bytes(bytes) => Snapshot::Module(snapshot_module(bytes)),
            })
            .collect();
        let mut sources = Vec::with_capacity(snapshots.len());
        for source in snapshots {
            if cancellation.inner.is_cancelled() {
                return Err(sdk_error(wasmer_sdk::Error::Cancelled));
            }
            sources.push(match source {
                Snapshot::Registry(specifier) => PackageSource::Registry(specifier),
                Snapshot::Module(module) => module_source(module, &cancellation.inner).await,
            });
        }
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
