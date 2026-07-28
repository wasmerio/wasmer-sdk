use std::{
    path::PathBuf,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{
    Command, CommandSelector, Error, Package, PackageSource, Result, SandboxFileSystem, Wasmer,
};

/// Builds a process-free sandbox.
#[derive(Debug)]
pub struct SandboxBuilder {
    client: Wasmer,
    packages: Vec<PackageSource>,
    files: Vec<(PathBuf, Vec<u8>)>,
}

impl SandboxBuilder {
    pub(crate) fn new(client: Wasmer) -> Self {
        Self {
            client,
            packages: Vec::new(),
            files: Vec::new(),
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

        Ok(Sandbox {
            inner: Arc::new(SandboxInner {
                client: self.client,
                packages: RwLock::new(packages),
                workspace,
                fs,
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
    closed: AtomicBool,
}

impl std::fmt::Debug for Sandbox {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Sandbox")
            .field("closed", &self.inner.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
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
}
