#[cfg(feature = "sys")]
use std::borrow::Cow;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[cfg(feature = "sys")]
use wasmer_wasix::runtime::ModuleInput;
#[cfg(feature = "sys")]
use wasmer_wasix::virtual_net::host::LocalNetworking;
use wasmer_wasix::{
    Runtime, UnsupportedVirtualNetworking,
    runtime::OverriddenRuntime,
    virtual_net::{DynVirtualNetworking, NetworkError},
};

use crate::{
    Command, CommandSelector, Error, FileSystem, MountMode, Package, PackageSource, Result,
    SandboxFileSystem, Wasmer, process::ProcessControl,
};

/// Builds a process-free sandbox.
#[derive(Debug)]
pub struct SandboxBuilder {
    client: Wasmer,
    packages: Vec<PackageSource>,
    files: Vec<(PathBuf, Vec<u8>)>,
    env: BTreeMap<String, String>,
    mounts: Vec<MountSpec>,
    network: NetworkPolicy,
}

/// A value that can be mounted into a sandbox as an external filesystem.
///
/// Implemented for every [`FileSystem`] provider (including [`Directory`]) and
/// for `Arc<dyn FileSystem>`, so shared providers mount without manual
/// coercion.
///
/// [`Directory`]: crate::Directory
pub trait IntoFileSystem {
    fn into_filesystem(self) -> Arc<dyn FileSystem>;
}

impl IntoFileSystem for Arc<dyn FileSystem> {
    fn into_filesystem(self) -> Arc<dyn FileSystem> {
        self
    }
}

impl<T: FileSystem> IntoFileSystem for T {
    fn into_filesystem(self) -> Arc<dyn FileSystem> {
        Arc::new(self)
    }
}

impl SandboxBuilder {
    pub(crate) fn new(client: Wasmer) -> Self {
        Self {
            client,
            packages: Vec::new(),
            files: Vec::new(),
            env: BTreeMap::new(),
            mounts: Vec::new(),
            network: NetworkPolicy::Disabled,
        }
    }

    /// Add a package that will be resolved before sandbox creation completes.
    #[must_use]
    pub fn package(mut self, source: impl Into<PackageSource>) -> Self {
        self.packages.push(source.into());
        self
    }

    /// Seed a file. Relative paths resolve beneath `/workspace`.
    #[must_use]
    pub fn file(mut self, path: impl Into<PathBuf>, bytes: impl Into<Vec<u8>>) -> Self {
        self.files.push((path.into(), bytes.into()));
        self
    }

    /// Set one sandbox-wide environment value.
    ///
    /// Sandbox values apply to every command; per-command values override
    /// them. Environment variables are visible to all code in the sandbox.
    #[must_use]
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Set several sandbox-wide environment values.
    #[must_use]
    pub fn envs<I, K, V>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        self.env
            .extend(values.into_iter().map(|(key, value)| (key.into(), value.into())));
        self
    }

    /// Mount an external filesystem provider at an absolute guest path.
    #[must_use]
    pub fn mount(
        mut self,
        guest_path: impl Into<PathBuf>,
        filesystem: impl IntoFileSystem,
        mode: MountMode,
    ) -> Self {
        self.mounts.push(MountSpec {
            guest_path: guest_path.into(),
            filesystem: filesystem.into_filesystem(),
            mode,
        });
        self
    }

    /// Configure guest networking.
    ///
    /// Networking is disabled by default. [`NetworkPolicy::Host`] selects the
    /// target's explicitly installed host bridge (native sockets on `sys`,
    /// the injected JavaScript bridge on Node) and is therefore an
    /// unrestricted capability grant.
    #[must_use]
    pub fn network(mut self, policy: NetworkPolicy) -> Self {
        self.network = policy;
        self
    }

    /// Resolve packages and create the sandbox.
    ///
    /// # Errors
    ///
    /// Returns an error if the client is closed, a package cannot be loaded, or
    /// a seeded workspace file cannot be written.
    pub async fn start(self) -> Result<Sandbox> {
        self.client.ensure_open()?;

        let mut packages = Vec::with_capacity(self.packages.len());
        for source in self.packages {
            let package = self.client.load_package_source(source).await?;
            if !packages
                .iter()
                .any(|installed: &Package| installed.same_as(&package))
            {
                packages.push(package);
            }
        }

        let workspace = virtual_fs::mem_fs::FileSystem::default();
        let fs = SandboxFileSystem::new(workspace.clone());
        for (path, bytes) in self.files {
            fs.write(path, bytes).await?;
        }
        let mut mounts = Vec::with_capacity(self.mounts.len());
        for mount in self.mounts {
            validate_mount_path(&mount.guest_path)?;
            if mounts
                .iter()
                .any(|existing: &MountSpec| existing.guest_path == mount.guest_path)
            {
                return Err(Error::InvalidGuestPath {
                    path: mount.guest_path,
                    message: "a filesystem is already mounted at this path".to_owned(),
                });
            }
            mounts.push(mount);
        }

        let networking = match self.network {
            NetworkPolicy::Disabled => {
                Arc::new(UnsupportedVirtualNetworking::default()) as DynVirtualNetworking
            }
            NetworkPolicy::Host => host_networking(&self.client),
        };
        let runtime = build_sandbox_runtime(&self.client, Arc::clone(&networking));

        Ok(Sandbox {
            inner: Arc::new(SandboxInner {
                client: self.client,
                packages: RwLock::new(packages),
                workspace,
                fs,
                env: self.env,
                mounts,
                networking,
                runtime,
                processes: Mutex::new(Vec::new()),
                closed: AtomicBool::new(false),
            }),
        })
    }
}

/// A persistent package composition and workspace from which commands run.
#[derive(Clone)]
pub struct Sandbox {
    pub(crate) inner: Arc<SandboxInner>,
}

#[cfg_attr(not(feature = "sys"), allow(dead_code))]
pub(crate) struct SandboxInner {
    pub(crate) client: Wasmer,
    pub(crate) packages: RwLock<Vec<Package>>,
    pub(crate) workspace: virtual_fs::mem_fs::FileSystem,
    pub(crate) fs: SandboxFileSystem,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) mounts: Vec<MountSpec>,
    pub(crate) networking: DynVirtualNetworking,
    pub(crate) runtime: Arc<dyn Runtime + Send + Sync>,
    processes: Mutex<Vec<Weak<ProcessControl>>>,
    closed: AtomicBool,
}

/// Guest network authority for a sandbox.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NetworkPolicy {
    /// Guest socket operations fail; no external network is reachable.
    #[default]
    Disabled,
    /// Guest sockets use the host network without address filtering.
    Host,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(feature = "sys"), allow(dead_code))]
pub(crate) struct MountSpec {
    pub(crate) guest_path: PathBuf,
    pub(crate) filesystem: Arc<dyn FileSystem>,
    pub(crate) mode: MountMode,
}

impl std::fmt::Debug for Sandbox {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Sandbox")
            .field("closed", &self.inner.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

fn validate_mount_path(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::InvalidGuestPath {
            path: path.to_owned(),
            message: "mount paths must be absolute".to_owned(),
        });
    }
    super::fs::validate_guest_path(path)?;
    if path == Path::new("/") || path == Path::new("/workspace") {
        return Err(Error::InvalidGuestPath {
            path: path.to_owned(),
            message: "the root and `/workspace` are reserved mount points".to_owned(),
        });
    }
    Ok(())
}

impl Sandbox {
    /// Construct a command. Resolution occurs when it is executed.
    #[must_use]
    pub fn command(&self, selector: impl Into<CommandSelector>) -> Command {
        Command::new(self.clone(), selector.into())
    }

    /// Resolve and atomically add a package to this sandbox.
    ///
    /// # Errors
    ///
    /// Returns an error if the client or sandbox is closed, package resolution
    /// fails, or internal package state is unavailable.
    pub async fn install_package(&self, source: impl Into<PackageSource>) -> Result<Package> {
        self.ensure_open()?;
        let package = self.inner.client.load_package(source).await?;
        self.ensure_open()?;
        let mut packages = self
            .inner
            .packages
            .write()
            .map_err(|_| Error::InternalState {
                message: "the installed-package lock is poisoned".to_owned(),
            })?;
        if let Some(installed) = packages
            .iter()
            .find(|installed| installed.same_as(&package))
        {
            return Ok(installed.clone());
        }
        packages.push(package.clone());
        Ok(package)
    }

    /// Access the persistent `/workspace` filesystem.
    #[must_use]
    pub fn fs(&self) -> &SandboxFileSystem {
        &self.inner.fs
    }

    /// Access guest port facilities.
    #[must_use]
    pub fn ports(&self) -> Ports {
        Ports {
            sandbox: self.clone(),
        }
    }

    /// Close the sandbox, kill its live processes, and reject future work.
    ///
    /// # Errors
    ///
    /// Returns an error if internal process state is unavailable.
    #[allow(clippy::unused_async)]
    pub async fn close(&self) -> Result<()> {
        self.inner.closed.store(true, Ordering::Release);
        let mut processes = self
            .inner
            .processes
            .lock()
            .map_err(|_| Error::InternalState {
                message: "the process registry lock is poisoned".to_owned(),
            })?;
        for process in processes.iter().filter_map(Weak::upgrade) {
            process.kill();
        }
        processes.clear();
        Ok(())
    }

    pub(crate) fn ensure_open(&self) -> Result<()> {
        self.inner.client.ensure_open()?;
        if self.inner.closed.load(Ordering::Acquire) {
            Err(Error::SandboxClosed)
        } else {
            Ok(())
        }
    }

    pub(crate) fn register_process(&self, process: &Arc<ProcessControl>) -> Result<()> {
        let mut processes = self
            .inner
            .processes
            .lock()
            .map_err(|_| Error::InternalState {
                message: "the process registry lock is poisoned".to_owned(),
            })?;
        processes.retain(|process| process.strong_count() > 0);
        processes.push(Arc::downgrade(process));
        Ok(())
    }
}

/// Guest port facilities for one sandbox.
#[derive(Clone, Debug)]
pub struct Ports {
    sandbox: Sandbox,
}

/// How often [`Ports::wait`] probes the guest port.
const PORT_PROBE_INTERVAL: Duration = Duration::from_millis(50);

impl Ports {
    /// Wait until a guest TCP listener accepts connections on `port`.
    ///
    /// The probe uses the sandbox's own network policy, so it observes
    /// exactly what the guest exposed and fails with
    /// [`Error::CapabilityUnavailable`] when networking is disabled.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Timeout`] when the port does not accept a connection
    /// within `timeout`, and [`Error::CapabilityUnavailable`] when the
    /// sandbox has no networking.
    pub async fn wait(&self, port: u16, timeout: Duration) -> Result<()> {
        let peer = SocketAddr::from(([127, 0, 0, 1], port));
        let local = SocketAddr::from(([0, 0, 0, 0], 0));
        let networking = Arc::clone(&self.sandbox.inner.networking);
        let tasks = Arc::clone(self.sandbox.inner.runtime.task_manager());
        let mut remaining = timeout;
        loop {
            self.sandbox.ensure_open()?;
            match networking.connect_tcp(local, peer).await {
                Ok(_connection) => return Ok(()),
                Err(NetworkError::Unsupported) => {
                    return Err(Error::CapabilityUnavailable {
                        capability: "port probing requires sandbox networking",
                    });
                }
                Err(_not_yet_listening) => {}
            }
            if remaining.is_zero() {
                return Err(Error::Timeout {
                    operation: format!("guest port {port} to accept connections"),
                });
            }
            let step = PORT_PROBE_INTERVAL.min(remaining);
            tasks.sleep_now(step).await;
            remaining = remaining.saturating_sub(step);
        }
    }
}

/// Build the per-sandbox runtime once: policy networking plus the WebAssembly
/// C API host-import hooks. Every spawn reuses this runtime.
fn build_sandbox_runtime(
    client: &Wasmer,
    networking: DynVirtualNetworking,
) -> Arc<dyn Runtime + Send + Sync> {
    let base: Arc<dyn Runtime + Send + Sync> = Arc::clone(&client.inner.runtime) as Arc<_>;
    let runtime: Arc<dyn Runtime + Send + Sync> =
        Arc::new(OverriddenRuntime::new(base).with_networking(networking));
    let runtime_for_resolver = Arc::clone(&runtime);
    let hooks =
        wasmer_c_api_imports::WasmCapiRuntimeHooks::new().with_resolve_module_sync(move |bytes| {
            resolve_capi_module(runtime_for_resolver.as_ref(), bytes)
        });

    Arc::new(OverriddenRuntime::new(runtime).with_instantiation_hook(hooks))
}

#[cfg(feature = "sys")]
fn resolve_capi_module(
    runtime: &(dyn Runtime + Send + Sync),
    bytes: Vec<u8>,
) -> anyhow::Result<wasmer::Module> {
    runtime
        .resolve_module_sync(ModuleInput::Bytes(Cow::Owned(bytes)), None, None)
        .map_err(anyhow::Error::from)
}

#[cfg(all(not(feature = "sys"), feature = "js"))]
fn resolve_capi_module(
    runtime: &(dyn Runtime + Send + Sync),
    bytes: Vec<u8>,
) -> anyhow::Result<wasmer::Module> {
    let store = runtime.new_store();
    wasmer::Module::new(&store, bytes).map_err(anyhow::Error::from)
}

#[cfg(feature = "sys")]
fn host_networking(_client: &Wasmer) -> DynVirtualNetworking {
    Arc::new(LocalNetworking::default())
}

#[cfg(not(feature = "sys"))]
fn host_networking(client: &Wasmer) -> DynVirtualNetworking {
    Arc::clone(client.inner.runtime.networking())
}
