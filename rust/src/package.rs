use std::{fmt, path::PathBuf, sync::Arc};

use bytes::Bytes;
use wasmer_wasix::bin_factory::BinaryPackage;

use crate::{Error, Result};

mod definition;
pub use definition::{PackageCommandDefinition, PackageDefinition};

/// A source from which a Wasmer package can be loaded.
#[derive(Clone, Debug)]
pub enum PackageSource {
    /// A package identifier resolved through the Wasmer registry.
    Registry(String),
    /// A local WEBC file or a directory containing `wasmer.toml`.
    Path(PathBuf),
    /// In-memory WEBC or raw WASI/WASIX module bytes, detected by their contents.
    /// A raw module becomes a package with one command and entrypoint, `main`.
    Bytes(Bytes),
    /// A previously compiled raw module, identified by its original SHA-256.
    /// Its artifact must already exist in this client's compiled-module cache.
    #[cfg(feature = "sys-runtime")]
    PrecompiledModule { sha256: [u8; 32] },
    /// Raw WASI/WASIX module bytes with their SHA-256, already computed by
    /// the caller (the browser bindings use the host's native digest). The
    /// SDK uses it instead of hashing the module again. It must be the
    /// SHA-256 of `bytes`: compiled modules are cached by it.
    WasmModule {
        bytes: Bytes,
        sha256: [u8; 32],
        /// The caller has already checked the module format and `_start` export.
        validated: bool,
    },
    /// An in-memory WEBC container.
    Webc(Bytes),
    /// An already resolved package.
    Package(Package),
}

impl PackageSource {
    /// Select a compiled raw module without retaining or reading its bytes.
    /// Cache misses report [`Error::ModuleNotCompiled`] when it is executed.
    #[cfg(feature = "sys-runtime")]
    #[must_use]
    pub fn precompiled_module(sha256: [u8; 32]) -> Self {
        Self::PrecompiledModule { sha256 }
    }

    #[must_use]
    pub fn registry(specifier: impl Into<String>) -> Self {
        Self::Registry(specifier.into())
    }

    #[must_use]
    pub fn path(path: impl Into<PathBuf>) -> Self {
        Self::Path(path.into())
    }

    #[must_use]
    pub fn webc(bytes: impl Into<Bytes>) -> Self {
        Self::Webc(bytes.into())
    }

    #[must_use]
    pub fn bytes(bytes: impl Into<Bytes>) -> Self {
        Self::Bytes(bytes.into())
    }

    /// Raw module bytes and their SHA-256 (see [`PackageSource::WasmModule`]).
    #[must_use]
    pub fn wasm_module(bytes: impl Into<Bytes>, sha256: [u8; 32]) -> Self {
        Self::module(bytes, sha256, false)
    }

    /// Raw module bytes with a trusted digest and optional prior validation.
    ///
    /// `sha256` must identify these exact bytes. Set `validated` only after
    /// checking that they encode a core Wasm module exporting a `_start`
    /// function. Package metadata is always checked; compilation still
    /// validates executable code. Use [`Self::wasm_module`] to have the SDK
    /// check the module format and exports.
    #[must_use]
    pub fn module(bytes: impl Into<Bytes>, sha256: [u8; 32], validated: bool) -> Self {
        Self::WasmModule {
            bytes: bytes.into(),
            sha256,
            validated,
        }
    }

    pub(crate) fn label(&self) -> String {
        match self {
            Self::Registry(specifier) => specifier.clone(),
            Self::Path(path) => path.display().to_string(),
            #[cfg(feature = "sys-runtime")]
            Self::PrecompiledModule { .. } => "<precompiled module>".to_owned(),
            Self::Bytes(bytes) | Self::WasmModule { bytes, .. } => {
                format!("<{} in-memory package bytes>", bytes.len())
            }
            Self::Webc(bytes) => format!("<{} in-memory WEBC bytes>", bytes.len()),
            Self::Package(package) => package.id(),
        }
    }
}

impl From<&str> for PackageSource {
    fn from(value: &str) -> Self {
        Self::Registry(value.to_owned())
    }
}

impl From<String> for PackageSource {
    fn from(value: String) -> Self {
        Self::Registry(value)
    }
}

impl From<PathBuf> for PackageSource {
    fn from(value: PathBuf) -> Self {
        Self::Path(value)
    }
}

impl From<Bytes> for PackageSource {
    fn from(value: Bytes) -> Self {
        Self::Bytes(value)
    }
}

impl From<Vec<u8>> for PackageSource {
    fn from(value: Vec<u8>) -> Self {
        Self::Bytes(value.into())
    }
}

impl From<Package> for PackageSource {
    fn from(value: Package) -> Self {
        Self::Package(value)
    }
}

/// A resolved Wasmer package.
#[derive(Clone)]
pub struct Package {
    pub(crate) inner: Arc<PackageInner>,
}

pub(crate) struct PackageInner {
    pub(crate) binary: BinaryPackage,
}

impl Package {
    pub(crate) fn from_binary(binary: BinaryPackage) -> Self {
        Self {
            inner: Arc::new(PackageInner { binary }),
        }
    }

    /// The resolved package identifier.
    #[must_use]
    pub fn id(&self) -> String {
        self.inner.binary.id.to_string()
    }

    /// All executable command names exported by this package tree.
    #[must_use]
    pub fn commands(&self) -> Vec<String> {
        self.inner
            .binary
            .commands
            .iter()
            .map(|command| command.name().to_owned())
            .collect()
    }

    /// The command executed when this package itself is used as a command
    /// selector, if the package declares one unambiguously.
    #[must_use]
    pub fn entrypoint(&self) -> Option<String> {
        self.inner
            .binary
            .infer_entrypoint()
            .ok()
            .map(ToOwned::to_owned)
    }

    /// Select a named command from this package.
    ///
    /// # Errors
    ///
    /// Returns an error if the package does not export the requested command.
    pub fn command(&self, name: impl Into<String>) -> Result<CommandRef> {
        let name = name.into();
        if self.inner.binary.get_command(&name).is_none() {
            return Err(Error::CommandNotFound { command: name });
        }
        Ok(CommandRef {
            package: self.clone(),
            name,
        })
    }

    pub(crate) fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner) || self.inner.binary.id == other.inner.binary.id
    }
}

impl fmt::Debug for Package {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Package")
            .field("id", &self.id())
            .field("commands", &self.commands())
            .finish()
    }
}

/// A command explicitly qualified by its package.
#[derive(Clone, Debug)]
pub struct CommandRef {
    pub(crate) package: Package,
    pub(crate) name: String,
}

impl CommandRef {
    #[must_use]
    pub fn package(&self) -> &Package {
        &self.package
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// A command name, package-qualified command, or package entrypoint.
#[derive(Clone, Debug)]
pub enum CommandSelector {
    Name(String),
    Ref(CommandRef),
    Package(Package),
}

impl From<&str> for CommandSelector {
    fn from(value: &str) -> Self {
        Self::Name(value.to_owned())
    }
}

impl From<String> for CommandSelector {
    fn from(value: String) -> Self {
        Self::Name(value)
    }
}

impl From<CommandRef> for CommandSelector {
    fn from(value: CommandRef) -> Self {
        Self::Ref(value)
    }
}

impl From<Package> for CommandSelector {
    fn from(value: Package) -> Self {
        Self::Package(value)
    }
}
