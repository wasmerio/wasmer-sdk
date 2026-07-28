use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
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
    mounts: Vec<MountSpec>,
    network: NetworkPolicy,
}

impl SandboxBuilder {
    pub(crate) fn new(client: Wasmer) -> Self {
        Self {
            client,
            packages: Vec::new(),
            files: Vec::new(),
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

    /// Mount an external filesystem provider at an absolute guest path.
    #[must_use]
    pub fn mount(
        mut self,
        guest_path: impl Into<PathBuf>,
        filesystem: Arc<dyn FileSystem>,
        mode: MountMode,
    ) -> Self {
        self.mounts.push(MountSpec {
            guest_path: guest_path.into(),
            filesystem,
            mode,
        });
        self
    }

    /// Configure guest networking.
    ///
    /// Networking is disabled by default. [`NetworkPolicy::Host`] gives guest
    /// sockets direct access to the native host network and is therefore an
    /// explicit, unrestricted capability grant.
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
        #[cfg(not(feature = "sys"))]
        if self.network == NetworkPolicy::Host {
            return Err(Error::CapabilityUnavailable {
                capability: "host networking",
            });
        }

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

        Ok(Sandbox {
            inner: Arc::new(SandboxInner {
                client: self.client,
                packages: RwLock::new(packages),
                workspace,
                fs,
                mounts,
                network: self.network,
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

pub(crate) struct SandboxInner {
    pub(crate) client: Wasmer,
    pub(crate) packages: RwLock<Vec<Package>>,
    pub(crate) workspace: virtual_fs::mem_fs::FileSystem,
    pub(crate) fs: SandboxFileSystem,
    pub(crate) mounts: Vec<MountSpec>,
    pub(crate) network: NetworkPolicy,
    processes: Mutex<Vec<Weak<ProcessControl>>>,
    closed: AtomicBool,
}

/// Guest network authority for a sandbox.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NetworkPolicy {
    /// Guest socket operations use an unsupported network backend.
    #[default]
    Disabled,
    /// Guest sockets use the native host network without address filtering.
    Host,
}

#[derive(Clone, Debug)]
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

    /// Close the sandbox and reject future commands or installations.
    ///
    /// # Errors
    ///
    /// Reserved for process-cleanup failures once live processes are
    /// introduced.
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
