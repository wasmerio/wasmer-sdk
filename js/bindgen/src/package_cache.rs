use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context as TaskContext, Poll},
};

use anyhow::{Context, Error, bail};
use bytes::Bytes;
use js_sys::{Promise, Uint8Array};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;
use wasmer_wasix::runtime::{
    package_loader::PackageCache,
    resolver::{DistributionInfo, QueryCache, WebcHash},
};
use web_sys::{Cache, CacheStorage, Response};

use crate::{task_manager::JsSendFuture, worker_utils::GlobalScope};

#[wasm_bindgen]
extern "C" {
    #[derive(Clone, Debug)]
    pub type NodeCacheBridge;

    #[wasm_bindgen(method, getter)]
    fn id(this: &NodeCacheBridge) -> u32;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCacheGet)]
    fn node_cache_get(bridge_id: u32, path: String) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCachePut)]
    fn node_cache_put(bridge_id: u32, path: String, bytes: &[u8]) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCacheRemove)]
    fn node_cache_remove(bridge_id: u32, path: String) -> Result<Promise, JsValue>;
}

#[derive(Clone)]
pub(crate) enum HostPackageCache {
    Browser {
        cache_name: Arc<str>,
        read_only: bool,
    },
    Node {
        bridge_id: u32,
    },
}

impl std::fmt::Debug for HostPackageCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Browser {
                cache_name,
                read_only,
            } => formatter
                .debug_struct("BrowserPackageCache")
                .field("cache_name", cache_name)
                .field("read_only", read_only)
                .finish(),
            Self::Node { bridge_id } => formatter
                .debug_struct("NodePackageCache")
                .field("bridge_id", bridge_id)
                .finish(),
        }
    }
}

impl HostPackageCache {
    pub(crate) fn browser(namespace: Option<&str>, read_only: bool) -> Self {
        let namespace = namespace.unwrap_or("default");
        Self::Browser {
            cache_name: Arc::from(format!("wasmer-sdk-cache-v1-{namespace}")),
            read_only,
        }
    }

    pub(crate) fn node(bridge: &NodeCacheBridge) -> Self {
        Self::Node {
            bridge_id: bridge.id(),
        }
    }

    async fn get_path(&self, path: &str) -> Result<Option<Bytes>, Error> {
        match self {
            Self::Browser { cache_name, .. } => {
                WorkerBoundFuture(browser_get(Arc::clone(cache_name), path.to_owned())).await
            }
            Self::Node { bridge_id } => {
                let promise = node_cache_get(*bridge_id, path.to_owned()).map_err(js_error)?;
                let value = JsSendFuture(JsFuture::from(promise))
                    .await
                    .map_err(js_error)?;
                if value.is_null() || value.is_undefined() {
                    Ok(None)
                } else {
                    Ok(Some(Bytes::from(Uint8Array::new(&value).to_vec())))
                }
            }
        }
    }

    async fn put_path(&self, path: &str, bytes: Bytes) -> Result<(), Error> {
        match self {
            Self::Browser {
                cache_name,
                read_only,
            } => {
                if *read_only {
                    return Ok(());
                }
                WorkerBoundFuture(browser_put(Arc::clone(cache_name), path.to_owned(), bytes)).await
            }
            Self::Node { bridge_id } => {
                let promise =
                    node_cache_put(*bridge_id, path.to_owned(), &bytes).map_err(js_error)?;
                JsSendFuture(JsFuture::from(promise))
                    .await
                    .map_err(js_error)?;
                Ok(())
            }
        }
    }

    async fn remove_path(&self, path: &str) -> Result<(), Error> {
        match self {
            Self::Browser {
                cache_name,
                read_only,
            } => {
                if *read_only {
                    return Ok(());
                }
                WorkerBoundFuture(browser_remove(Arc::clone(cache_name), path.to_owned())).await
            }
            Self::Node { bridge_id } => {
                let promise = node_cache_remove(*bridge_id, path.to_owned()).map_err(js_error)?;
                JsSendFuture(JsFuture::from(promise))
                    .await
                    .map_err(js_error)?;
                Ok(())
            }
        }
    }
}

/// Browser JavaScript values are bound to the worker that created them. The
/// WASIX cache traits require `Send`, while the SDK scheduler guarantees that
/// these futures are only polled on their originating worker.
struct WorkerBoundFuture<F>(F);

unsafe impl<F> Send for WorkerBoundFuture<F> {}
unsafe impl<F> Sync for WorkerBoundFuture<F> {}

impl<F: Future> Future for WorkerBoundFuture<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        // SAFETY: the wrapped future is never moved after this wrapper is pinned.
        let this = unsafe { self.as_mut().get_unchecked_mut() };
        unsafe { Pin::new_unchecked(&mut this.0) }.poll(context)
    }
}

#[async_trait::async_trait]
impl QueryCache for HostPackageCache {
    async fn load(&self, package_name: &str) -> Result<Option<Bytes>, Error> {
        self.get_path(&registry_path(package_name)).await
    }

    async fn save(&self, package_name: &str, bytes: Bytes) -> Result<(), Error> {
        self.put_path(&registry_path(package_name), bytes).await
    }

    async fn remove(&self, package_name: &str) -> Result<(), Error> {
        self.remove_path(&registry_path(package_name)).await
    }
}

#[async_trait::async_trait]
impl PackageCache for HostPackageCache {
    async fn lookup(&self, hash: &WebcHash) -> Result<Option<webc::Container>, Error> {
        let path = package_path(hash);
        let Some(bytes) = self.get_path(&path).await? else {
            return Ok(None);
        };
        if WebcHash::sha256(&bytes) != *hash {
            let _ = self.remove_path(&path).await;
            return Ok(None);
        }
        wasmer_package::utils::from_bytes(bytes)
            .map(Some)
            .context("unable to decode cached WEBC")
    }

    async fn save(&self, webc: Bytes, dist: &DistributionInfo) -> Result<webc::Container, Error> {
        let actual = WebcHash::sha256(&webc);
        if actual != dist.webc_sha256 {
            bail!(
                "downloaded WEBC hash {actual} does not match expected hash {}",
                dist.webc_sha256
            );
        }
        self.put_path(&package_path(&dist.webc_sha256), webc.clone())
            .await?;
        wasmer_package::utils::from_bytes(webc).context("unable to decode downloaded WEBC")
    }
}

async fn browser_cache(name: &str) -> Result<Cache, Error> {
    let storage = cache_storage()?;
    let cache = JsSendFuture(JsFuture::from(storage.open(name)))
        .await
        .map_err(js_error)?;
    cache
        .dyn_into()
        .map_err(|_| Error::msg("CacheStorage.open() returned a non-Cache value"))
}

async fn browser_get(cache_name: Arc<str>, path: String) -> Result<Option<Bytes>, Error> {
    let cache = browser_cache(&cache_name).await?;
    let value = JsFuture::from(cache.match_with_str(&cache_key(&path)))
        .await
        .map_err(js_error)?;
    if value.is_undefined() {
        return Ok(None);
    }
    let response: Response = value
        .dyn_into()
        .map_err(|_| Error::msg("browser package cache returned a non-Response"))?;
    let buffer = JsFuture::from(response.array_buffer().map_err(js_error)?)
        .await
        .map_err(js_error)?;
    Ok(Some(Bytes::from(Uint8Array::new(&buffer).to_vec())))
}

async fn browser_put(cache_name: Arc<str>, path: String, bytes: Bytes) -> Result<(), Error> {
    let cache = browser_cache(&cache_name).await?;
    let mut body = bytes.to_vec();
    let response = Response::new_with_opt_u8_array(Some(&mut body)).map_err(js_error)?;
    JsFuture::from(cache.put_with_str(&cache_key(&path), &response))
        .await
        .map_err(js_error)?;
    Ok(())
}

async fn browser_remove(cache_name: Arc<str>, path: String) -> Result<(), Error> {
    let cache = browser_cache(&cache_name).await?;
    JsFuture::from(cache.delete_with_str(&cache_key(&path)))
        .await
        .map_err(js_error)?;
    Ok(())
}

fn cache_storage() -> Result<CacheStorage, Error> {
    match GlobalScope::current() {
        GlobalScope::Window(window) => window.caches().map_err(js_error),
        GlobalScope::Worker(worker) => worker.caches().map_err(js_error),
        GlobalScope::Other(_) => bail!("CacheStorage is unavailable in this JavaScript host"),
    }
}

fn registry_path(package_name: &str) -> String {
    format!(
        "cache-v1/registry/{}",
        package_name.replace('/', "#").replace('\\', "#")
    )
}

fn package_path(hash: &WebcHash) -> String {
    format!("cache-v1/packages/{}.bin", hash.as_hex())
}

fn cache_key(path: &str) -> String {
    let encoded = String::from(js_sys::encode_uri_component(path));
    format!("https://wasmer-sdk.invalid/{}", encoded)
}

fn js_error(value: JsValue) -> Error {
    crate::worker_utils::js_error(value)
}
