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
use web_sys::{Blob, Cache, CacheStorage, Response};

use crate::{task_manager::JsSendFuture, worker_utils::GlobalScope};

#[wasm_bindgen]
extern "C" {
    #[derive(Clone, Debug)]
    pub type NodeCacheBridge;

    #[wasm_bindgen(method, getter)]
    fn id(this: &NodeCacheBridge) -> u32;

    /// Opens a cached file. Resolves to `{ handle, size }`, or `undefined`
    /// when the file does not exist.
    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCacheOpen)]
    fn node_cache_open(bridge_id: u32, path: String) -> Result<Promise, JsValue>;

    /// Reads an opened file into `destination` and closes it. Resolves to the
    /// number of bytes read.
    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCacheReadInto)]
    fn node_cache_read_into(
        bridge_id: u32,
        handle: u32,
        destination: &Uint8Array,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeCacheCloseFile)]
    fn node_cache_close_file(bridge_id: u32, handle: u32) -> Result<Promise, JsValue>;

    /// Writes `bytes` to the cache. The host reads them until the promise
    /// settles, without copying them first.
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
            Self::Node { bridge_id } => WorkerBoundFuture(node_get(*bridge_id, path)).await,
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
                WorkerBoundFuture(node_put(*bridge_id, path.to_owned(), bytes)).await
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

/// JavaScript values are bound to the worker that created them. The
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

/// Read a cached file straight into one SDK allocation of its size: the host
/// writes into a view of that allocation, so no whole-file JavaScript buffer
/// is created. Freed multi-megabyte buffers stay dirty in the allocator (macOS
/// keeps them until a later purge), so each one avoided lowers the footprint.
async fn node_get(bridge_id: u32, path: &str) -> Result<Option<Bytes>, Error> {
    let promise = node_cache_open(bridge_id, path.to_owned()).map_err(js_error)?;
    let opened = JsFuture::from(promise).await.map_err(js_error)?;
    if opened.is_null() || opened.is_undefined() {
        return Ok(None);
    }
    let handle = number_field(&opened, "handle")?;
    let file = OpenFile {
        bridge_id,
        handle: Some(handle as u32),
    };
    let size = number_field(&opened, "size")?;
    if !(0.0..=u32::MAX as f64).contains(&size) || size.fract() != 0.0 {
        bail!("cached file {path} has an unsupported size of {size} bytes");
    }
    let size = size as usize;
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(size)
        .with_context(|| format!("unable to allocate {size} bytes for cached file {path}"))?;
    // SAFETY: the view covers the vector's spare capacity, which nothing else
    // uses while the host writes it. SDK memory is shared, so growing it
    // never detaches this view.
    let destination = unsafe { Uint8Array::view_mut_raw(buffer.as_mut_ptr(), size) };
    let promise =
        node_cache_read_into(bridge_id, file.release(), &destination).map_err(js_error)?;
    let (result, mut buffer) = HostBorrow::new(promise, buffer).await;
    let read = result.map_err(js_error)?.as_f64().unwrap_or(-1.0);
    if read != size as f64 {
        bail!("cached file {path} changed size while it was read");
    }
    // SAFETY: the host initialized all `size` bytes.
    unsafe { buffer.set_len(size) };
    Ok(Some(Bytes::from(buffer)))
}

/// Write `bytes` straight from SDK memory, without a JavaScript copy.
async fn node_put(bridge_id: u32, path: String, bytes: Bytes) -> Result<(), Error> {
    let promise = node_cache_put(bridge_id, path, &bytes).map_err(js_error)?;
    let (result, _bytes) = HostBorrow::new(promise, bytes).await;
    result.map_err(js_error)?;
    Ok(())
}

fn number_field(value: &JsValue, name: &str) -> Result<f64, Error> {
    js_sys::Reflect::get(value, &JsValue::from_str(name))
        .map_err(js_error)?
        .as_f64()
        .with_context(|| format!("package cache returned no numeric `{name}`"))
}

/// Closes an opened cache file unless it was handed to a read, which closes
/// it itself.
struct OpenFile {
    bridge_id: u32,
    handle: Option<u32>,
}

impl OpenFile {
    fn release(mut self) -> u32 {
        self.handle.take().expect("an open file has a handle")
    }
}

impl Drop for OpenFile {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take()
            && let Ok(promise) = node_cache_close_file(self.bridge_id, handle)
        {
            // Await it so a failure is not an unhandled rejection.
            let closed = JsFuture::from(promise);
            wasm_bindgen_futures::spawn_local(async move {
                let _ = closed.await;
            });
        }
    }
}

/// Awaits a host promise that reads or writes `owner`'s memory in place.
///
/// If this future is dropped first (a cancelled load), `owner` is kept until
/// the promise settles: freeing it earlier would let the host read or write
/// memory that the SDK has already reused.
struct HostBorrow<T: Unpin + 'static> {
    promise: Promise,
    future: JsFuture,
    owner: Option<T>,
}

impl<T: Unpin + 'static> HostBorrow<T> {
    fn new(promise: Promise, owner: T) -> Self {
        Self {
            future: JsFuture::from(promise.clone()),
            promise,
            owner: Some(owner),
        }
    }
}

impl<T: Unpin + 'static> Future for HostBorrow<T> {
    type Output = (Result<JsValue, JsValue>, T);

    fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let result = std::task::ready!(Pin::new(&mut this.future).poll(context));
        let owner = this
            .owner
            .take()
            .expect("HostBorrow polled after completion");
        Poll::Ready((result, owner))
    }
}

impl<T: Unpin + 'static> Drop for HostBorrow<T> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let settled = JsFuture::from(self.promise.clone());
            wasm_bindgen_futures::spawn_local(async move {
                let _ = settled.await;
                drop(owner);
            });
        }
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
    // A Blob gives the exact size up front and is read in slices, so neither
    // a whole-file ArrayBuffer nor a growing SDK buffer is needed.
    let blob: Blob = JsFuture::from(response.blob().map_err(js_error)?)
        .await
        .map_err(js_error)?
        .dyn_into()
        .map_err(|_| Error::msg("browser package cache returned a non-Blob body"))?;
    let size = blob.size();
    if !(0.0..=u32::MAX as f64).contains(&size) {
        bail!("cached file {path} has an unsupported size of {size} bytes");
    }
    let size = size as usize;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .with_context(|| format!("unable to allocate {size} bytes for cached file {path}"))?;
    while bytes.len() < size {
        let start = bytes.len();
        let end = size.min(start + BROWSER_READ_CHUNK);
        let slice = blob
            .slice_with_f64_and_f64(start as f64, end as f64)
            .map_err(js_error)?;
        let chunk = JsFuture::from(slice.array_buffer())
            .await
            .map_err(js_error)?;
        let chunk = Uint8Array::new(&chunk);
        if chunk.length() as usize != end - start {
            bail!("cached file {path} changed size while it was read");
        }
        chunk.copy_to_uninit(&mut bytes.spare_capacity_mut()[..end - start]);
        // SAFETY: `copy_to_uninit` initialized these bytes.
        unsafe { bytes.set_len(end) };
    }
    Ok(Some(Bytes::from(bytes)))
}

/// Slice size for browser cache reads.
const BROWSER_READ_CHUNK: usize = 1 << 20;

async fn browser_put(cache_name: Arc<str>, path: String, bytes: Bytes) -> Result<(), Error> {
    let cache = browser_cache(&cache_name).await?;
    // `Response` copies a BufferSource body when it is constructed, so a view
    // of the SDK's bytes suffices: no second copy in SDK memory.
    // SAFETY: nothing allocates between creating the view and that copy.
    let body = unsafe { Uint8Array::view(&bytes) };
    let response = Response::new_with_opt_buffer_source(Some(&body)).map_err(js_error)?;
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
