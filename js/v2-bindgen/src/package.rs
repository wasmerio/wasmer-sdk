//! SDK package policy over byte-backed v2 facade packages. No v1 execution graph.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};
use wasixv2::{Machine, OwnedBuffer, ProcessConfig};
use wasmparser::{Encoding, ExternalKind, Parser, Payload};

pub type Result<T> = std::result::Result<T, PackageError>;

#[derive(Debug, Serialize)]
pub struct PackageError {
    pub code: &'static str,
    pub message: String,
}
impl PackageError {
    pub fn load(message: impl std::fmt::Display) -> Self {
        Self {
            code: "PACKAGE_LOAD_FAILED",
            message: message.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Metadata {
    pub id: String,
    pub commands: Vec<String>,
    pub entrypoint: Option<String>,
}

/// An in-memory executable package. No registry identity or WEBC archive is needed.
///
/// File keys are canonical absolute guest paths (for example `/data/config.json`).
/// Bundled files are immutable package contents; execution uses the same writable
/// overlays as WEBC packages. Use the sandbox workspace for persistent writes.
#[derive(Clone, Debug, Default)]
pub struct DefinitionInput {
    pub modules: BTreeMap<String, OwnedBuffer>,
    pub commands: BTreeMap<String, CommandDefinition>,
    /// A command name. Omit to infer the entrypoint when there is one command.
    pub entrypoint: Option<String>,
    pub files: BTreeMap<String, OwnedBuffer>,
}

/// A WASI/WASIX command referencing a module in the same definition.
#[derive(Clone, Debug, Deserialize)]
pub struct CommandDefinition {
    pub module: String,
}

impl DefinitionInput {
    pub fn raw(bytes: OwnedBuffer) -> Self {
        Self {
            modules: [("main".into(), bytes)].into(),
            commands: [(
                "main".into(),
                CommandDefinition {
                    module: "main".into(),
                },
            )]
            .into(),
            entrypoint: Some("main".into()),
            files: BTreeMap::new(),
        }
    }
    pub async fn materialize(mut self, clock: Arc<dyn wasixv2_vfs::Clock>) -> Result<Package> {
        self.validate()?;
        if self.entrypoint.is_none() && self.commands.len() == 1 {
            self.entrypoint = self.commands.keys().next().cloned();
        }
        let id = hash_id(self.hash());
        let commands = self
            .commands
            .into_iter()
            .map(|(name, command)| (name, self.modules[&command.module].clone()))
            .collect::<Vec<_>>();
        let root = materialize_files(self.files, clock).await?;
        Ok(Package::Memory(Memory {
            metadata: Metadata {
                id,
                commands: commands.iter().map(|(name, _)| name.clone()).collect(),
                entrypoint: self.entrypoint,
            },
            commands,
            root,
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

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError {
        code: "INVALID_ARGUMENT",
        message: message.into(),
    }
}
fn module_error(name: &str, message: impl Into<String>) -> PackageError {
    PackageError::load(format!("in-memory module `{name}`: {}", message.into()))
}
fn hash_id(hash: [u8; 32]) -> String {
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

pub enum Package {
    Webc(Arc<Archive>),
    Memory(Memory),
}

pub struct Memory {
    metadata: Metadata,
    commands: Vec<(String, OwnedBuffer)>,
    root: Option<Arc<dyn wasixv2::Filesystem>>,
}

pub struct Archive {
    metadata: Metadata,
    package: Arc<wasixv2::Package>,
    dependencies: BTreeMap<String, Arc<Archive>>,
}

impl Archive {
    pub fn from_bytes(
        bytes: OwnedBuffer,
        dependencies: BTreeMap<String, Arc<Archive>>,
    ) -> Result<Self> {
        let version = webc::detect(&bytes).map_err(PackageError::load)?;
        if !matches!(version, webc::Version::V2 | webc::Version::V3) {
            return Err(PackageError::load(format!("unsupported WEBC {version}")));
        }
        let container =
            webc::Container::from_bytes_and_version(bytes.clone().into_bytes(), version)
                .map_err(PackageError::load)?;
        for alias in container.manifest().use_map.keys() {
            if !dependencies.contains_key(alias) {
                return Err(PackageError::load(format!(
                    "missing supplied dependency {alias}"
                )));
            }
        }
        // Match the current SDK's manifest name/version, then original-container
        // hash fallback. V2 identity is not the hash of its migrated V3 image.
        let wapm = container.manifest().wapm().map_err(PackageError::load)?;
        let id = if let Some(name) = wapm.as_ref().and_then(|value| value.name.as_ref()) {
            let version = wapm
                .as_ref()
                .and_then(|value| value.version.as_deref())
                .unwrap_or("0.0.0")
                .parse::<semver::Version>()
                .map_err(PackageError::load)?;
            format!("{name}@{version}")
        } else {
            hash_id(
                container
                    .webc_hash()
                    .ok_or_else(|| PackageError::load("webc file did not provide its hash"))?,
            )
        };
        let mut package = wasixv2::Package::from_bytes(bytes).map_err(PackageError::load)?;
        for (alias, dependency) in &dependencies {
            package = package.with_dependency(alias, dependency.package.clone());
        }
        let mut commands = Vec::new();
        let mut names = HashSet::new();
        for name in package.commands() {
            if names.insert(name.to_owned()) {
                commands.push(name.to_owned());
            }
        }
        for dependency in dependencies.values() {
            for name in &dependency.metadata.commands {
                if names.insert(name.clone()) {
                    commands.push(name.clone());
                }
            }
        }
        let entrypoint = package
            .entrypoint()
            .map(str::to_owned)
            .or_else(|| (commands.len() == 1).then(|| commands[0].clone()));
        Ok(Self {
            metadata: Metadata {
                id,
                commands,
                entrypoint,
            },
            package: Arc::new(package),
            dependencies,
        })
    }

    fn binary(&self, name: &str) -> Result<OwnedBuffer> {
        if self.package.commands().any(|candidate| candidate == name) {
            return self.package.binary(name).map_err(PackageError::load);
        }
        for dependency in self.dependencies.values() {
            if dependency
                .metadata
                .commands
                .iter()
                .any(|candidate| candidate == name)
            {
                return dependency.binary(name);
            }
        }
        Err(PackageError {
            code: "COMMAND_NOT_FOUND",
            message: format!("unknown package command `{name}`"),
        })
    }

    fn prepare(
        &self,
        machine: &mut Machine,
        name: &str,
        config: &mut ProcessConfig,
    ) -> Result<String> {
        if self.package.commands().any(|candidate| candidate == name) {
            return self
                .package
                .prepare_command(machine, Some(name), config)
                .map_err(PackageError::load);
        }
        for dependency in self.dependencies.values() {
            if dependency
                .metadata
                .commands
                .iter()
                .any(|candidate| candidate == name)
            {
                return dependency.prepare(machine, name, config);
            }
        }
        Err(PackageError {
            code: "COMMAND_NOT_FOUND",
            message: format!("unknown package command `{name}`"),
        })
    }
}

impl Package {
    pub fn metadata(&self) -> &Metadata {
        match self {
            Self::Webc(package) => &package.metadata,
            Self::Memory(package) => &package.metadata,
        }
    }

    pub fn binary(&self, name: &str) -> Result<OwnedBuffer> {
        match self {
            Self::Webc(package) => package.binary(name),
            Self::Memory(package) => package
                .commands
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, bytes)| bytes.clone())
                .ok_or_else(|| PackageError {
                    code: "COMMAND_NOT_FOUND",
                    message: format!("unknown package command `{name}`"),
                }),
        }
    }

    pub fn prepare(
        &self,
        machine: &mut Machine,
        name: &str,
        config: &mut ProcessConfig,
    ) -> Result<String> {
        match self {
            Self::Webc(package) => package.prepare(machine, name, config),
            Self::Memory(_) => {
                self.binary(name)?;
                config.args.insert(0, name.to_owned());
                Ok(format!("/bin/{name}"))
            }
        }
    }
}

pub async fn install(machine: &mut Machine, packages: &[Arc<Package>]) -> Result<()> {
    let sources = packages
        .iter()
        .map(|package| match package.as_ref() {
            Package::Webc(package) => wasixv2::PackageInstallSource::Webc(package.package.as_ref()),
            Package::Memory(package) => wasixv2::PackageInstallSource::Memory {
                commands: &package.commands,
                root: package.root.clone(),
            },
        })
        .collect::<Vec<_>>();
    wasixv2::install_package_sources(machine, &sources)
        .await
        .map_err(PackageError::load)
}

async fn materialize_files(
    files: BTreeMap<String, OwnedBuffer>,
    clock: Arc<dyn wasixv2_vfs::Clock>,
) -> Result<Option<Arc<dyn wasixv2::Filesystem>>> {
    if files.is_empty() {
        return Ok(None);
    }
    use wasixv2_abi::OpenFlags;
    use wasixv2_vfs::{Cred, Ctx, LookupFlags, OpenHow, Vfs};
    let fs = wasixv2::browser::directory(clock, 0o755, 0, 0)
        .await
        .map_err(fs_error)?;
    let vfs = Vfs::new(fs.clone());
    let root = vfs.root();
    let cred = Cred::root();
    let cx = Ctx {
        cred: &cred,
        root: &root,
        umask: 0o022,
        task: 0,
        leases: None,
    };
    for (path, bytes) in files {
        if let Some((parent, _)) = path.rsplit_once('/')
            && !parent.is_empty()
        {
            vfs.mkdir_all(&cx, parent.as_bytes())
                .await
                .map_err(fs_error)?;
        }
        let file = vfs
            .open(
                &cx,
                &root,
                path.as_bytes(),
                &OpenHow {
                    flags: OpenFlags::O_WRONLY | OpenFlags::O_CREAT | OpenFlags::O_EXCL,
                    mode: 0o644,
                    lookup: LookupFlags {
                        in_root: true,
                        no_symlinks: true,
                        ..LookupFlags::follow()
                    },
                },
            )
            .await
            .map_err(fs_error)?;
        let mut offset = 0;
        while offset < bytes.len() {
            let count = file
                .write_at(&bytes[offset..], offset as u64)
                .await
                .map_err(fs_error)?;
            if count == 0 {
                return Err(PackageError::load("zero-length package file write"));
            }
            offset += count;
        }
    }
    Ok(Some(fs))
}

fn fs_error(errno: wasixv2_abi::Errno) -> PackageError {
    PackageError::load(std::io::Error::from_raw_os_error(errno.0))
}
