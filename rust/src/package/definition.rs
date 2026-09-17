use std::{collections::BTreeMap, path::Path, sync::Arc};

use bytes::Bytes;
use sha2::{Digest, Sha256};
use virtual_fs::{AsyncWriteExt, FileSystem};
use wasmer_config::package::{PackageHash, PackageId};
use wasmer_types::ModuleHash;
use wasmer_wasix::bin_factory::{BinaryPackage, BinaryPackageCommand, BinaryPackageMounts};
use wasmparser::{Encoding, ExternalKind, Parser, Payload};

use crate::{Error, Package, Result};

/// An in-memory executable package. No registry identity or WEBC archive is needed.
///
/// File keys are canonical absolute guest paths (for example `/data/config.json`).
/// Bundled files are immutable package contents; execution uses the same writable
/// overlays as WEBC packages. Use the sandbox workspace for persistent writes.
#[derive(Clone, Debug, Default)]
pub struct PackageDefinition {
    pub modules: BTreeMap<String, Bytes>,
    pub commands: BTreeMap<String, PackageCommandDefinition>,
    /// A command name. Omit to infer the entrypoint when there is one command.
    pub entrypoint: Option<String>,
    pub files: BTreeMap<String, Bytes>,
}

/// A WASI/WASIX command referencing a module in the same definition.
#[derive(Clone, Debug)]
pub struct PackageCommandDefinition {
    pub module: String,
}

impl PackageDefinition {
    pub(crate) fn from_wasm(bytes: Bytes) -> Self {
        Self {
            modules: [("main".into(), bytes)].into(),
            commands: [(
                "main".into(),
                PackageCommandDefinition {
                    module: "main".into(),
                },
            )]
            .into(),
            entrypoint: Some("main".into()),
            ..Self::default()
        }
    }

    pub(crate) async fn into_package(mut self) -> Result<Package> {
        self.validate()?;
        if self.entrypoint.is_none() && self.commands.len() == 1 {
            self.entrypoint = self.commands.keys().next().cloned();
        }
        let id = PackageId::Hash(PackageHash::from_sha256_bytes(self.hash()));
        let atoms: BTreeMap<_, _> = self
            .modules
            .into_iter()
            .map(|(name, bytes)| {
                let hash = ModuleHash::sha256(&bytes);
                (name, (webc::compat::SharedBytes::from(bytes), hash))
            })
            .collect();
        let commands = self
            .commands
            .into_iter()
            .map(|(name, command)| {
                let (atom, hash) = &atoms[&command.module];
                BinaryPackageCommand::new(
                    name,
                    webc::metadata::Command {
                        runner: "https://webc.org/runner/wasi".to_owned(),
                        ..webc::metadata::Command::default()
                    },
                    atom.clone(),
                    *hash,
                    None,
                    id.clone(),
                    id.clone(),
                )
            })
            .collect();
        let file_system_memory_footprint =
            self.files.values().map(|bytes| bytes.len() as u64).sum();
        let package_mounts = if self.files.is_empty() {
            None
        } else {
            Some(Arc::new(BinaryPackageMounts {
                root_layer: Some(Arc::new(build_filesystem(self.files).await?)),
                mounts: vec![],
            }))
        };
        Ok(Package::from_binary(BinaryPackage {
            id,
            package_ids: vec![],
            // Runtime metadata only; no container is created or serialized.
            webc_version: webc::Version::V3,
            when_cached: None,
            entrypoint_cmd: self.entrypoint,
            // OnceCell belongs to the runtime; avoid another direct dependency.
            #[allow(clippy::default_trait_access)]
            hash: Default::default(),
            package_mounts,
            commands,
            uses: vec![],
            file_system_memory_footprint,
            additional_host_mapped_directories: vec![],
        }))
    }

    fn validate(&self) -> Result<()> {
        if self.commands.is_empty() {
            return Err(invalid(
                "a package definition must contain at least one command",
            ));
        }
        let mut starts = BTreeMap::new();
        for (name, bytes) in &self.modules {
            validate_name("module", name)?;
            starts.insert(name, module_has_start(name, bytes)?);
        }
        for (name, command) in &self.commands {
            validate_name("command", name)?;
            let Some(has_start) = starts.get(&command.module) else {
                return Err(invalid(format!(
                    "command `{name}` references missing module `{}`",
                    command.module
                )));
            };
            if !has_start {
                return Err(module_error(
                    &command.module,
                    "WASI/WASIX commands require an exported `_start` function",
                ));
            }
        }
        if let Some(entrypoint) = &self.entrypoint
            && !self.commands.contains_key(entrypoint)
        {
            return Err(invalid(format!(
                "entrypoint `{entrypoint}` is not a command"
            )));
        }
        for path in self.files.keys() {
            // Validate the spelling, not Path::components(), which discards `.`
            // and duplicate separators and behaves differently on Windows.
            if !path.starts_with('/')
                || path.contains(['\\', '\0'])
                || path[1..]
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(invalid(format!(
                    "package file `{path}` must be a canonical absolute guest path"
                )));
            }
            let mut ancestor = path.as_str();
            while let Some((parent, _)) = ancestor.rsplit_once('/') {
                if self.files.contains_key(parent) {
                    return Err(invalid(format!(
                        "package file `{parent}` is also a directory for `{path}`"
                    )));
                }
                ancestor = parent;
            }
        }
        Ok(())
    }

    fn hash(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(b"wasmer-sdk:package-definition:v1\0");
        hash.update((self.modules.len() as u64).to_le_bytes());
        for (name, bytes) in &self.modules {
            hash_field(&mut hash, name.as_bytes());
            hash_field(&mut hash, bytes);
        }
        hash.update((self.commands.len() as u64).to_le_bytes());
        for (name, command) in &self.commands {
            hash_field(&mut hash, name.as_bytes());
            hash_field(&mut hash, command.module.as_bytes());
        }
        // Empty names are invalid, so the empty field unambiguously means None.
        hash_field(
            &mut hash,
            self.entrypoint.as_deref().unwrap_or_default().as_bytes(),
        );
        hash.update((self.files.len() as u64).to_le_bytes());
        for (path, bytes) in &self.files {
            hash_field(&mut hash, path.as_bytes());
            hash_field(&mut hash, bytes);
        }
        hash.finalize().into()
    }
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn validate_name(kind: &str, name: &str) -> Result<()> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.+".contains(&c))
    {
        return Err(invalid(format!(
            "{kind} name `{name}` must contain only ASCII letters, digits, '-', '_', '.', or '+' and cannot be empty, '.' or '..'"
        )));
    }
    Ok(())
}

fn module_has_start(name: &str, bytes: &[u8]) -> Result<bool> {
    let mut has_start = false;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|error| module_error(name, error.to_string()))? {
            Payload::Version {
                encoding: Encoding::Component,
                ..
            } => {
                return Err(module_error(
                    name,
                    "WebAssembly components are not supported by the sandbox command runner",
                ));
            }
            Payload::ExportSection(exports) => {
                for export in exports {
                    let export = export.map_err(|error| module_error(name, error.to_string()))?;
                    has_start |= export.name == "_start" && export.kind == ExternalKind::Func;
                }
            }
            _ => {}
        }
    }
    Ok(has_start)
}

async fn build_filesystem(
    files: BTreeMap<String, Bytes>,
) -> Result<virtual_fs::mem_fs::FileSystem> {
    let fs = virtual_fs::mem_fs::FileSystem::default();
    for (path, bytes) in files {
        let guest = Path::new(&path);
        let fail = |error: virtual_fs::FsError| Error::FileSystem {
            operation: "create package file",
            path: guest.to_owned(),
            message: error.to_string(),
        };
        if let Some(parent) = guest.parent() {
            virtual_fs::create_dir_all(&fs, parent).map_err(fail)?;
        }
        let mut file = fs
            .new_open_options()
            .write(true)
            .create_new(true)
            .open(guest)
            .map_err(fail)?;
        file.write_all(&bytes).await?;
    }
    Ok(fs)
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidArgument {
        message: message.into(),
    }
}

fn module_error(name: &str, message: impl Into<String>) -> Error {
    Error::PackageLoad {
        package_source: format!("in-memory module `{name}`"),
        message: message.into(),
    }
}
