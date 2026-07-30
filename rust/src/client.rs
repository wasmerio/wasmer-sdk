use std::{
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(feature = "sys")]
use std::{collections::HashMap, sync::RwLock, time::Duration};
use wasmer_config::package::PackageSource as WasmerPackageSource;
#[cfg(feature = "sys")]
use wasmer_wasix::runtime::{
    module_cache::{FileSystemCache, ModuleCache, SharedCache},
    resolver::{BackendSource, MultiSource},
    task_manager::tokio::TokioTaskManager,
};
use wasmer_wasix::{
    PluggableRuntime, bin_factory::BinaryPackage, http::HttpClient,
    runtime::package_loader::BuiltinPackageLoader,
};

use crate::{Error, Package, PackageSource, Result, SandboxBuilder};

#[cfg(feature = "sys")]
const REGISTRY_QUERY_CACHE_TTL: Duration = Duration::from_mins(10);

/// Persistent cache configuration.
#[derive(Clone, Debug)]
pub struct CacheConfig {
    /// Cache root. Package and compiled-artifact caches are children of it.
    pub root: PathBuf,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            root: PathBuf::from(".wasmer"),
        }
    }
}

/// Client-wide SDK configuration.
#[derive(Clone, Debug)]
pub struct WasmerConfig {
    pub cache: CacheConfig,
    /// Maximum bytes retained from each captured output stream.
    pub output_bytes: usize,
}

impl Default for WasmerConfig {
    fn default() -> Self {
        Self {
            cache: CacheConfig::default(),
            output_bytes: 16 * 1024 * 1024,
        }
    }
}

/// Shared entry point for package and sandbox services.
#[derive(Clone)]
pub struct Wasmer {
    pub(crate) inner: Arc<ClientInner>,
}

/// Package acquisition operations for one [`Wasmer`] client.
#[derive(Clone, Debug)]
pub struct Packages {
    client: Wasmer,
}

/// Sandbox creation operations for one [`Wasmer`] client.
#[derive(Clone, Debug)]
pub struct Sandboxes {
    client: Wasmer,
}

pub(crate) struct ClientInner {
    pub(crate) runtime: Arc<PluggableRuntime>,
    #[cfg(feature = "sys")]
    pub(crate) tasks: Arc<TokioTaskManager>,
    pub(crate) output_bytes: usize,
    #[cfg(feature = "sys")]
    registry_packages: RwLock<HashMap<String, Package>>,
    closed: AtomicBool,
}

impl std::fmt::Debug for Wasmer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Wasmer")
            .field("closed", &self.inner.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl Wasmer {
    /// Create a client and initialize its package and compiled-artifact caches.
    ///
    /// # Errors
    ///
    /// Returns an error when the cache directories, async runtime, or target
    /// HTTP client cannot be initialized.
    #[cfg(feature = "sys")]
    pub fn new(config: WasmerConfig) -> Result<Self> {
        let http_client: Arc<dyn HttpClient + Send + Sync> =
            Arc::new(wasmer_wasix::http::default_http_client().ok_or_else(|| {
                Error::Initialization {
                    message: "this target has no default HTTP client".to_owned(),
                }
            })?);
        Self::new_with_http_client(config, http_client)
    }

    #[cfg(feature = "sys")]
    fn new_with_http_client(
        config: WasmerConfig,
        http_client: Arc<dyn HttpClient + Send + Sync>,
    ) -> Result<Self> {
        let cache_root = absolutize(config.cache.root)?;
        let package_cache = cache_root.join("cache-v1").join("packages");
        let registry_cache = cache_root.join("cache-v1").join("registry");
        let compiled_cache = cache_root
            .join("cache-v1")
            .join("compiled")
            .join(target_identity())
            .join(engine_identity());

        for directory in [&package_cache, &registry_cache, &compiled_cache] {
            std::fs::create_dir_all(directory).map_err(|error| Error::Initialization {
                message: format!(
                    "unable to create cache directory `{}`: {error}",
                    directory.display()
                ),
            })?;
        }

        let tasks = if let Ok(handle) = tokio::runtime::Handle::try_current() {
            Arc::new(TokioTaskManager::new(handle))
        } else {
            let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("wasmer-sdk")
                .build()
                .map_err(|error| Error::Initialization {
                    message: format!("unable to create the runtime: {error}"),
                })?;
            Arc::new(TokioTaskManager::new(tokio_runtime))
        };
        let module_cache = SharedCache::default()
            .with_fallback(FileSystemCache::new(compiled_cache, Arc::clone(&tasks)));
        let mut source = MultiSource::new();
        source.add_source(
            BackendSource::new(
                BackendSource::WASMER_PROD_ENDPOINT
                    .parse()
                    .expect("the Wasmer registry endpoint is valid"),
                Arc::clone(&http_client),
            )
            .with_local_cache(registry_cache, REGISTRY_QUERY_CACHE_TTL),
        );
        let mut runtime = PluggableRuntime::new(Arc::clone(&tasks) as Arc<_>);
        runtime
            .set_module_cache(module_cache)
            .set_source(source)
            .set_package_loader(
                BuiltinPackageLoader::new()
                    .with_cache_dir(package_cache)
                    .with_shared_http_client(Arc::clone(&http_client)),
            )
            .set_http_client(http_client);

        Ok(Self {
            inner: Arc::new(ClientInner {
                runtime: Arc::new(runtime),
                tasks,
                output_bytes: config.output_bytes,
                registry_packages: RwLock::new(HashMap::new()),
                closed: AtomicBool::new(false),
            }),
        })
    }

    /// Create a JavaScript-target client around an injected WASIX runtime.
    ///
    /// The `wasmer-sdk-js` facade uses this constructor to supply its task
    /// manager and target-specific virtual networking. Package and
    /// compiled-module caching is currently in-memory on this target.
    ///
    /// # Errors
    ///
    /// Returns an error if the target has no default HTTP client.
    #[cfg(feature = "js")]
    pub fn from_js_runtime(config: &WasmerConfig, mut runtime: PluggableRuntime) -> Result<Self> {
        let http_client: Arc<dyn HttpClient + Send + Sync> =
            Arc::new(wasmer_wasix::http::default_http_client().ok_or_else(|| {
                Error::Initialization {
                    message: "this target has no default HTTP client".to_owned(),
                }
            })?);
        runtime
            .set_package_loader(
                BuiltinPackageLoader::new().with_shared_http_client(Arc::clone(&http_client)),
            )
            .set_http_client(http_client);

        Ok(Self {
            inner: Arc::new(ClientInner {
                runtime: Arc::new(runtime),
                output_bytes: config.output_bytes,
                closed: AtomicBool::new(false),
            }),
        })
    }

    /// Access package acquisition operations.
    #[must_use]
    pub fn packages(&self) -> Packages {
        Packages {
            client: self.clone(),
        }
    }

    /// Access sandbox creation operations.
    #[must_use]
    pub fn sandboxes(&self) -> Sandboxes {
        Sandboxes {
            client: self.clone(),
        }
    }

    /// Resolve a registry, local, or in-memory package.
    ///
    /// # Errors
    ///
    /// Returns an error if the client is closed, the source is invalid, package
    /// acquisition fails, or the package cannot be decoded and resolved.
    #[deprecated(note = "use `wasmer.packages().load(source)`")]
    pub async fn load_package(&self, source: impl Into<PackageSource>) -> Result<Package> {
        self.packages().load(source).await
    }

    /// Start configuring a fresh sandbox.
    #[must_use]
    #[deprecated(note = "use `wasmer.sandboxes().create()`")]
    pub fn sandbox(&self) -> SandboxBuilder {
        self.sandboxes().create()
    }

    /// Reject future work through this client and every clone of it.
    ///
    /// # Errors
    ///
    /// Reserved for cleanup failures once persistent background workers are
    /// introduced.
    #[allow(clippy::unused_async)]
    pub async fn shutdown(&self) -> Result<()> {
        self.inner.closed.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn ensure_open(&self) -> Result<()> {
        if self.inner.closed.load(Ordering::Acquire) {
            Err(Error::ClientClosed)
        } else {
            Ok(())
        }
    }

    pub(crate) async fn load_package_source(&self, source: PackageSource) -> Result<Package> {
        if let PackageSource::Package(package) = source {
            return Ok(package);
        }

        let label = source.label();
        let binary = match source {
            PackageSource::Registry(specifier) => {
                let parsed = WasmerPackageSource::from_str(&specifier).map_err(|error| {
                    Error::InvalidPackageSource {
                        package_source: specifier.clone(),
                        message: error.to_string(),
                    }
                })?;
                #[cfg(feature = "sys")]
                {
                    let cache_key = parsed.to_string();
                    if let Some(package) = self
                        .inner
                        .registry_packages
                        .read()
                        .map_err(|_| Error::InternalState {
                            message: "the loaded-package cache lock is poisoned".to_owned(),
                        })?
                        .get(&cache_key)
                        .cloned()
                    {
                        return Ok(package);
                    }

                    let binary = BinaryPackage::from_registry(&parsed, self.inner.runtime.as_ref())
                        .await
                        .map_err(|error| Error::PackageLoad {
                            package_source: label,
                            message: format!("{error:#}"),
                        })?;
                    let package = Package::from_binary(binary);
                    let mut packages =
                        self.inner
                            .registry_packages
                            .write()
                            .map_err(|_| Error::InternalState {
                                message: "the loaded-package cache lock is poisoned".to_owned(),
                            })?;
                    return Ok(packages
                        .entry(cache_key)
                        .or_insert_with(|| package.clone())
                        .clone());
                }
                #[cfg(not(feature = "sys"))]
                {
                    BinaryPackage::from_registry(&parsed, self.inner.runtime.as_ref()).await
                }
            }
            #[cfg(feature = "sys")]
            PackageSource::Path(path) if path.is_dir() => {
                BinaryPackage::from_dir(&path, self.inner.runtime.as_ref()).await
            }
            #[cfg(feature = "sys")]
            PackageSource::Path(path) => {
                let container = wasmer_package::utils::from_disk(&path).map_err(|error| {
                    Error::PackageLoad {
                        package_source: path.display().to_string(),
                        message: error.to_string(),
                    }
                })?;
                BinaryPackage::from_webc(&container, self.inner.runtime.as_ref()).await
            }
            #[cfg(not(feature = "sys"))]
            PackageSource::Path(path) => {
                return Err(Error::PackageLoad {
                    package_source: path.display().to_string(),
                    message:
                        "host paths are unavailable in WebAssembly; pass the package bytes instead"
                            .to_owned(),
                });
            }
            PackageSource::Webc(bytes) => {
                let container = wasmer_package::utils::from_bytes(bytes).map_err(|error| {
                    Error::PackageLoad {
                        package_source: label.clone(),
                        message: error.to_string(),
                    }
                })?;
                BinaryPackage::from_webc(&container, self.inner.runtime.as_ref()).await
            }
            PackageSource::Package(_) => unreachable!("handled above"),
        }
        .map_err(|error| Error::PackageLoad {
            package_source: label,
            message: format!("{error:#}"),
        })?;

        Ok(Package::from_binary(binary))
    }
}

impl Packages {
    /// Resolve a registry, local, or in-memory package.
    ///
    /// # Errors
    ///
    /// Returns an error if the client is closed, the source is invalid, package
    /// acquisition fails, or the package cannot be decoded and resolved.
    pub async fn load(&self, source: impl Into<PackageSource>) -> Result<Package> {
        self.client.ensure_open()?;
        self.client.load_package_source(source.into()).await
    }
}

impl Sandboxes {
    /// Begin creating a sandbox.
    ///
    /// Configure the returned builder and await it to finish creation.
    #[must_use]
    pub fn create(&self) -> SandboxBuilder {
        SandboxBuilder::new(self.client.clone())
    }
}

#[cfg(feature = "sys")]
fn absolutize(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|current| current.join(path))
        .map_err(|error| Error::Initialization {
            message: format!("unable to determine the current directory: {error}"),
        })
}

#[cfg(feature = "sys")]
fn target_identity() -> String {
    format!(
        "{}-{}-{}",
        std::env::consts::ARCH,
        std::env::consts::OS,
        std::env::consts::FAMILY
    )
}

#[cfg(feature = "sys")]
fn engine_identity() -> &'static str {
    #[cfg(feature = "sys")]
    {
        "cranelift"
    }
    #[cfg(all(not(feature = "sys"), feature = "js"))]
    {
        "javascript"
    }
    #[cfg(not(any(feature = "sys", feature = "js")))]
    {
        "headless"
    }
}

#[cfg(all(test, feature = "sys"))]
mod tests {
    use std::{
        collections::VecDeque,
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use futures::future::BoxFuture;
    use http::{HeaderMap, StatusCode};
    use tempfile::TempDir;
    use wasmer_wasix::{
        http::{HttpClient, HttpRequest, HttpResponse},
        runtime::resolver::WebcHash,
    };

    use super::{CacheConfig, Wasmer, WasmerConfig};

    #[derive(Debug, Default)]
    struct MockHttpClient {
        responses: Mutex<VecDeque<HttpResponse>>,
        requests: AtomicUsize,
    }

    impl MockHttpClient {
        fn new(responses: impl IntoIterator<Item = HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: AtomicUsize::new(0),
            }
        }

        fn requests(&self) -> usize {
            self.requests.load(Ordering::Acquire)
        }
    }

    impl HttpClient for MockHttpClient {
        fn request(&self, _request: HttpRequest) -> BoxFuture<'_, anyhow::Result<HttpResponse>> {
            self.requests.fetch_add(1, Ordering::AcqRel);
            let response = self
                .responses
                .lock()
                .expect("mock response lock poisoned")
                .pop_front();
            Box::pin(
                async move { response.ok_or_else(|| anyhow::anyhow!("unexpected HTTP request")) },
            )
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn registry_metadata_and_packages_survive_a_fresh_client() {
        let fixture = TempDir::new().expect("create package fixture");
        let webc = registry_fixture(fixture.path());
        let hash = WebcHash::sha256(&webc);
        let container =
            wasmer_package::utils::from_bytes(webc.clone()).expect("decode package fixture");
        let manifest = serde_json::to_string(container.manifest()).expect("serialize manifest");
        let release = serde_json::json!({
            "version": "1.0.0",
            "isArchived": false,
            "v2": {
                "webcManifest": manifest,
                "piritaDownloadUrl": "https://packages.test/cache.webc",
                "piritaSha256Hash": hash.as_hex(),
            },
            "v3": {
                "webcManifest": manifest,
                "piritaDownloadUrl": "https://packages.test/cache.webc",
                "piritaSha256Hash": hash.as_hex(),
            },
        });
        let registry_response = HttpResponse {
            body: Some(
                serde_json::to_vec(&serde_json::json!({
                    "data": {
                        "getPackage": {
                            "packageName": "cache",
                            "namespace": "sdk-test",
                            "versions": [release],
                        },
                        "info": {
                            "defaultFrontend": "https://wasmer.io/",
                        },
                    },
                }))
                .expect("serialize registry response"),
            ),
            redirected: false,
            status: StatusCode::OK,
            headers: HeaderMap::new(),
        };
        let package_response = HttpResponse {
            body: Some(webc.to_vec()),
            redirected: false,
            status: StatusCode::OK,
            headers: HeaderMap::new(),
        };

        let state = TempDir::new().expect("create cache fixture");
        let config = WasmerConfig {
            cache: CacheConfig {
                root: state.path().join(".wasmer"),
            },
            ..WasmerConfig::default()
        };
        let online = Arc::new(MockHttpClient::new([registry_response, package_response]));
        let client = Wasmer::new_with_http_client(config.clone(), online.clone());
        let client = client.expect("create online client");
        let first = client
            .packages()
            .load("sdk-test/cache@1.0.0")
            .await
            .expect("load registry package");
        let in_memory = client
            .packages()
            .load("sdk-test/cache@1.0.0")
            .await
            .expect("reuse loaded registry package");

        assert!(Arc::ptr_eq(&first.inner, &in_memory.inner));
        assert_eq!(online.requests(), 2);
        drop(first);
        drop(in_memory);
        drop(client);

        let offline = Arc::new(MockHttpClient::default());
        let client = Wasmer::new_with_http_client(config, offline.clone())
            .expect("create cache-only client");
        let cached = client
            .packages()
            .load("sdk-test/cache@1.0.0")
            .await
            .expect("load registry package entirely from disk");

        assert_eq!(cached.id(), "sdk-test/cache@1.0.0");
        assert_eq!(offline.requests(), 0);
        assert!(state.path().join(".wasmer/cache-v1/registry").is_dir());
        assert!(
            state
                .path()
                .join(".wasmer/cache-v1/packages")
                .join(format!("{}.bin", hash.as_hex()))
                .is_file()
        );
    }

    fn registry_fixture(directory: &Path) -> bytes::Bytes {
        let manifest = r#"
[package]
name = "sdk-test/cache"
version = "1.0.0"
description = "SDK cache fixture"
entrypoint = "echo"

[[module]]
name = "echo"
source = "echo.wasm"
abi = "wasi"

[[command]]
name = "echo"
module = "echo"
"#;
        std::fs::write(directory.join("wasmer.toml"), manifest).expect("write manifest");
        std::fs::write(
            directory.join("echo.wasm"),
            wat::parse_str("(module (func (export \"_start\")))").expect("compile fixture"),
        )
        .expect("write module");
        wasmer_package::package::Package::from_manifest(directory.join("wasmer.toml"))
            .expect("build package")
            .serialize()
            .expect("serialize package")
    }
}
