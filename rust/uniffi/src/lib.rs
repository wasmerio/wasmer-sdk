#![allow(clippy::missing_errors_doc, clippy::must_use_candidate)]

mod error;
mod runtime;

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

pub use error::SdkError;
use runtime::RuntimeContext;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::{
    Command, CommandRef, ExitReason, FileType, NetworkPolicy, Output, Package, PackageSource,
    Process, ProcessHandle, ProcessStderr, ProcessStdin, ProcessStdout, Sandbox, SandboxFileSystem,
    Stdio, Wasmer, WasmerConfig,
};

uniffi::setup_scaffolding!();

const DEFAULT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
#[derive(Clone, Debug, uniffi::Record)]
pub struct ClientOptions {
    pub cache_root: Option<String>,
    pub output_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum NetworkMode {
    Disabled,
    Host,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum InputMode {
    Closed,
    Pipe,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum OutputMode {
    Pipe,
    Capture,
    Discard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum ProcessExitReason {
    Exited,
    Terminated,
    Timeout,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct RunOptions {
    pub input: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
    pub output_bytes: Option<u64>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct SpawnOptions {
    pub timeout_ms: Option<u64>,
    pub output_bytes: Option<u64>,
    pub stdin: InputMode,
    pub stdout: OutputMode,
    pub stderr: OutputMode,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub reason: ProcessExitReason,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct FileStat {
    pub kind: FileKind,
    pub size: u64,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
}

#[derive(Debug, uniffi::Object)]
pub struct WasmerCore {
    context: Arc<RuntimeContext>,
    inner: Wasmer,
}

#[uniffi::export]
impl WasmerCore {
    #[uniffi::constructor]
    pub fn new(options: ClientOptions) -> Result<Arc<Self>, SdkError> {
        let context = RuntimeContext::new()?;
        let output_bytes = checked_usize(
            "output_bytes",
            options.output_bytes.unwrap_or(DEFAULT_OUTPUT_BYTES),
        )?;
        let mut config = WasmerConfig {
            output_bytes,
            ..WasmerConfig::default()
        };
        if let Some(cache_root) = options.cache_root {
            config.cache.root = PathBuf::from(cache_root);
        }
        let inner = {
            let _guard = context.enter();
            Wasmer::new(config).map_err(SdkError::from)?
        };
        Ok(Arc::new(Self { context, inner }))
    }

    pub async fn load_package_registry(
        &self,
        specifier: String,
    ) -> Result<Arc<PackageCore>, SdkError> {
        let client = self.inner.clone();
        let package = self
            .context
            .sdk(async move { client.packages().load(specifier).await })
            .await?;
        Ok(Arc::new(PackageCore::new(
            Arc::clone(&self.context),
            package,
        )))
    }

    pub async fn load_package_path(&self, path: String) -> Result<Arc<PackageCore>, SdkError> {
        let client = self.inner.clone();
        let package = self
            .context
            .sdk(async move {
                client
                    .packages()
                    .load(PackageSource::path(PathBuf::from(path)))
                    .await
            })
            .await?;
        Ok(Arc::new(PackageCore::new(
            Arc::clone(&self.context),
            package,
        )))
    }

    pub async fn load_package_bytes(&self, bytes: Vec<u8>) -> Result<Arc<PackageCore>, SdkError> {
        let client = self.inner.clone();
        let package = self
            .context
            .sdk(async move { client.packages().load(PackageSource::webc(bytes)).await })
            .await?;
        Ok(Arc::new(PackageCore::new(
            Arc::clone(&self.context),
            package,
        )))
    }

    pub async fn create_sandbox(
        &self,
        packages: Vec<Arc<PackageCore>>,
        files: HashMap<String, Vec<u8>>,
        env: HashMap<String, String>,
        network: NetworkMode,
    ) -> Result<Arc<SandboxCore>, SdkError> {
        let mut builder = self.inner.sandboxes().create().network(network.into());
        for package in packages {
            builder = builder.package(package.inner.clone());
        }
        for (path, contents) in files {
            builder = builder.file(path, contents);
        }
        for (key, value) in env {
            builder = builder.env(key, value);
        }
        let sandbox = self.context.sdk(async move { builder.await }).await?;
        Ok(Arc::new(SandboxCore::new(
            Arc::clone(&self.context),
            sandbox,
        )))
    }

    pub async fn close(&self) -> Result<(), SdkError> {
        let client = self.inner.clone();
        self.context
            .sdk(async move { client.shutdown().await })
            .await
    }
}

#[derive(Debug, uniffi::Object)]
pub struct PackageCore {
    _context: Arc<RuntimeContext>,
    inner: Package,
}

impl PackageCore {
    fn new(context: Arc<RuntimeContext>, inner: Package) -> Self {
        Self {
            _context: context,
            inner,
        }
    }
}

#[uniffi::export]
impl PackageCore {
    pub fn id(&self) -> String {
        self.inner.id()
    }

    pub fn commands(&self) -> Vec<String> {
        self.inner.commands()
    }

    pub fn entrypoint(&self) -> Option<String> {
        self.inner.entrypoint()
    }

    pub fn command(&self, name: String) -> Result<Arc<CommandRefCore>, SdkError> {
        self.inner
            .command(name)
            .map(|inner| Arc::new(CommandRefCore { inner }))
            .map_err(SdkError::from)
    }
}

#[derive(Debug, uniffi::Object)]
pub struct CommandRefCore {
    inner: CommandRef,
}

#[uniffi::export]
impl CommandRefCore {
    pub fn name(&self) -> String {
        self.inner.name().to_owned()
    }
}

#[derive(Debug, uniffi::Object)]
pub struct SandboxCore {
    context: Arc<RuntimeContext>,
    inner: Sandbox,
}

impl SandboxCore {
    fn new(context: Arc<RuntimeContext>, inner: Sandbox) -> Self {
        Self { context, inner }
    }

    fn configure_command(
        &self,
        mut command: Command,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Arc<CommandCore> {
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        Arc::new(CommandCore {
            context: Arc::clone(&self.context),
            inner: command,
        })
    }
}

#[uniffi::export]
impl SandboxCore {
    pub fn command_name(
        &self,
        name: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Arc<CommandCore> {
        self.configure_command(self.inner.command(name), args, cwd, env)
    }

    #[allow(clippy::needless_pass_by_value)] // UniFFI object arguments use Arc<T>.
    pub fn command_package(
        &self,
        package: Arc<PackageCore>,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Arc<CommandCore> {
        self.configure_command(self.inner.command(package.inner.clone()), args, cwd, env)
    }

    #[allow(clippy::needless_pass_by_value)] // UniFFI object arguments use Arc<T>.
    pub fn command_ref(
        &self,
        reference: Arc<CommandRefCore>,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Arc<CommandCore> {
        self.configure_command(self.inner.command(reference.inner.clone()), args, cwd, env)
    }

    pub async fn install_package_registry(
        &self,
        specifier: String,
    ) -> Result<Arc<PackageCore>, SdkError> {
        self.install(PackageSource::registry(specifier)).await
    }

    pub async fn install_package_path(&self, path: String) -> Result<Arc<PackageCore>, SdkError> {
        self.install(PackageSource::path(PathBuf::from(path))).await
    }

    pub async fn install_package_bytes(
        &self,
        bytes: Vec<u8>,
    ) -> Result<Arc<PackageCore>, SdkError> {
        self.install(PackageSource::webc(bytes)).await
    }

    pub async fn install_package_ref(
        &self,
        package: Arc<PackageCore>,
    ) -> Result<Arc<PackageCore>, SdkError> {
        self.install(PackageSource::from(package.inner.clone()))
            .await
    }

    pub fn filesystem(&self) -> Arc<FileSystemCore> {
        Arc::new(FileSystemCore {
            context: Arc::clone(&self.context),
            inner: self.inner.fs().clone(),
        })
    }

    pub fn ports(&self) -> Arc<PortsCore> {
        Arc::new(PortsCore {
            context: Arc::clone(&self.context),
            inner: self.inner.ports(),
        })
    }

    pub async fn close(&self) -> Result<(), SdkError> {
        let sandbox = self.inner.clone();
        self.context.sdk(async move { sandbox.close().await }).await
    }
}

impl SandboxCore {
    async fn install(&self, source: PackageSource) -> Result<Arc<PackageCore>, SdkError> {
        let sandbox = self.inner.clone();
        let package = self
            .context
            .sdk(async move { sandbox.install_package(source).await })
            .await?;
        Ok(Arc::new(PackageCore::new(
            Arc::clone(&self.context),
            package,
        )))
    }
}

#[derive(Debug, uniffi::Object)]
pub struct CommandCore {
    context: Arc<RuntimeContext>,
    inner: Command,
}

#[uniffi::export]
impl CommandCore {
    pub async fn run(&self, options: RunOptions) -> Result<ProcessOutput, SdkError> {
        let mut command = self.inner.clone();
        apply_common_options(&mut command, options.timeout_ms, options.output_bytes)?;
        if let Some(input) = options.input {
            command.input(input);
        }
        let output = self
            .context
            .sdk(async move { command.output().await })
            .await?;
        Ok(output.into())
    }

    pub async fn spawn(&self, options: SpawnOptions) -> Result<Arc<ProcessCore>, SdkError> {
        let mut command = self.inner.clone();
        apply_common_options(&mut command, options.timeout_ms, options.output_bytes)?;
        command
            .stdin(options.stdin.into())
            .stdout(options.stdout.into())
            .stderr(options.stderr.into());
        let mut process = self
            .context
            .sdk(async move { command.spawn().await })
            .await?;
        let handle = process.handle();
        let stdin = process.take_stdin();
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        Ok(Arc::new(ProcessCore {
            context: Arc::clone(&self.context),
            id: process.id(),
            handle,
            process: Arc::new(tokio::sync::Mutex::new(process)),
            stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
            stdout: Arc::new(tokio::sync::Mutex::new(stdout)),
            stderr: Arc::new(tokio::sync::Mutex::new(stderr)),
            has_stdin: options.stdin == InputMode::Pipe,
            has_stdout: options.stdout == OutputMode::Pipe,
            has_stderr: options.stderr == OutputMode::Pipe,
        }))
    }
}

#[derive(Debug, uniffi::Object)]
pub struct ProcessCore {
    context: Arc<RuntimeContext>,
    id: u32,
    handle: ProcessHandle,
    process: Arc<tokio::sync::Mutex<Process>>,
    stdin: Arc<tokio::sync::Mutex<Option<ProcessStdin>>>,
    stdout: Arc<tokio::sync::Mutex<Option<ProcessStdout>>>,
    stderr: Arc<tokio::sync::Mutex<Option<ProcessStderr>>>,
    has_stdin: bool,
    has_stdout: bool,
    has_stderr: bool,
}

#[uniffi::export]
impl ProcessCore {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn has_stdin(&self) -> bool {
        self.has_stdin
    }

    pub fn has_stdout(&self) -> bool {
        self.has_stdout
    }

    pub fn has_stderr(&self) -> bool {
        self.has_stderr
    }

    pub async fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), SdkError> {
        let stdin = Arc::clone(&self.stdin);
        self.context
            .io(async move {
                let mut stdin = stdin.lock().await;
                let writer = stdin
                    .as_mut()
                    .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
                writer.write_all(&bytes).await
            })
            .await
    }

    pub async fn close_stdin(&self) -> Result<(), SdkError> {
        let stdin = Arc::clone(&self.stdin);
        self.context
            .io(async move {
                let mut stdin = stdin.lock().await.take();
                if let Some(writer) = stdin.as_mut() {
                    writer.shutdown().await?;
                }
                Ok(())
            })
            .await
    }

    pub async fn read_stdout(&self, max_bytes: u64) -> Result<Option<Vec<u8>>, SdkError> {
        let max_bytes = checked_read_size(max_bytes)?;
        read_stream(
            Arc::clone(&self.context),
            Arc::clone(&self.stdout),
            max_bytes,
        )
        .await
    }

    pub async fn read_stderr(&self, max_bytes: u64) -> Result<Option<Vec<u8>>, SdkError> {
        let max_bytes = checked_read_size(max_bytes)?;
        read_stream(
            Arc::clone(&self.context),
            Arc::clone(&self.stderr),
            max_bytes,
        )
        .await
    }

    pub async fn wait(&self) -> Result<ProcessOutput, SdkError> {
        let process = Arc::clone(&self.process);
        self.context
            .sdk(async move { process.lock().await.wait().await })
            .await
            .map(ProcessOutput::from)
    }

    pub async fn terminate(&self, grace_ms: u64) -> Result<(), SdkError> {
        let handle = self.handle.clone();
        self.context
            .sdk(async move {
                handle.terminate(Duration::from_millis(grace_ms)).await;
                Ok(())
            })
            .await
    }

    pub fn kill(&self) {
        self.handle.kill();
    }
}

#[derive(Debug, uniffi::Object)]
pub struct FileSystemCore {
    context: Arc<RuntimeContext>,
    inner: SandboxFileSystem,
}

#[uniffi::export]
impl FileSystemCore {
    pub async fn write(&self, path: String, bytes: Vec<u8>) -> Result<(), SdkError> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.write(path, bytes).await })
            .await
    }

    pub async fn read(&self, path: String) -> Result<Vec<u8>, SdkError> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.read(path).await })
            .await
    }

    pub async fn mkdir(&self, path: String, recursive: bool) -> Result<(), SdkError> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move {
                if recursive {
                    filesystem.create_dir_all(path)
                } else {
                    filesystem.create_dir(path)
                }
            })
            .await
    }

    pub async fn read_dir(&self, path: String) -> Result<Vec<DirectoryEntry>, SdkError> {
        let filesystem = self.inner.clone();
        let entries = self
            .context
            .sdk(async move { filesystem.read_dir(path) })
            .await?;
        Ok(entries
            .into_iter()
            .map(|entry| DirectoryEntry {
                name: entry.name,
                kind: entry.metadata.file_type.into(),
                size: entry.metadata.len,
            })
            .collect())
    }

    pub async fn stat(&self, path: String) -> Result<FileStat, SdkError> {
        let filesystem = self.inner.clone();
        let metadata = self
            .context
            .sdk(async move { filesystem.stat(path) })
            .await?;
        Ok(FileStat {
            kind: metadata.file_type.into(),
            size: metadata.len,
        })
    }

    pub async fn remove(&self, path: String, recursive: bool) -> Result<(), SdkError> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.remove(path, recursive) })
            .await
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), SdkError> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.rename(from, to).await })
            .await
    }
}

#[derive(Debug, uniffi::Object)]
pub struct PortsCore {
    context: Arc<RuntimeContext>,
    inner: wasmer_sdk::Ports,
}

#[uniffi::export]
impl PortsCore {
    pub async fn wait(&self, port: u16, timeout_ms: u64) -> Result<(), SdkError> {
        if port == 0 {
            return Err(SdkError::invalid_argument(
                "`port` must be between 1 and 65535",
            ));
        }
        let ports = self.inner.clone();
        self.context
            .sdk(async move { ports.wait(port, Duration::from_millis(timeout_ms)).await })
            .await
    }
}

async fn read_stream<S>(
    context: Arc<RuntimeContext>,
    stream: Arc<tokio::sync::Mutex<Option<S>>>,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, SdkError>
where
    S: tokio::io::AsyncRead + Send + Unpin + 'static,
{
    context
        .io(async move {
            let mut stream = stream.lock().await;
            let Some(reader) = stream.as_mut() else {
                return Ok(None);
            };
            let mut bytes = vec![0_u8; max_bytes];
            let length = reader.read(&mut bytes).await?;
            if length == 0 {
                stream.take();
                return Ok(None);
            }
            bytes.truncate(length);
            Ok(Some(bytes))
        })
        .await
}

fn apply_common_options(
    command: &mut Command,
    timeout_ms: Option<u64>,
    output_bytes: Option<u64>,
) -> Result<(), SdkError> {
    if let Some(timeout_ms) = timeout_ms {
        command.timeout(Duration::from_millis(timeout_ms));
    }
    if let Some(output_bytes) = output_bytes {
        command.output_bytes(checked_usize("output_bytes", output_bytes)?);
    }
    Ok(())
}

fn checked_usize(name: &str, value: u64) -> Result<usize, SdkError> {
    usize::try_from(value).map_err(|_| {
        SdkError::invalid_argument(format!("`{name}` exceeds this target's addressable size"))
    })
}

fn checked_read_size(value: u64) -> Result<usize, SdkError> {
    if value == 0 {
        return Err(SdkError::invalid_argument(
            "`max_bytes` must be greater than zero",
        ));
    }
    checked_usize("max_bytes", value)
}

impl From<NetworkMode> for NetworkPolicy {
    fn from(value: NetworkMode) -> Self {
        match value {
            NetworkMode::Disabled => Self::Disabled,
            NetworkMode::Host => Self::Host,
        }
    }
}

impl From<InputMode> for Stdio {
    fn from(value: InputMode) -> Self {
        match value {
            InputMode::Closed => Self::Null,
            InputMode::Pipe => Self::Piped,
        }
    }
}

impl From<OutputMode> for Stdio {
    fn from(value: OutputMode) -> Self {
        match value {
            OutputMode::Pipe => Self::Piped,
            OutputMode::Capture => Self::Capture,
            OutputMode::Discard => Self::Null,
        }
    }
}

impl From<Output> for ProcessOutput {
    fn from(output: Output) -> Self {
        Self {
            exit_code: output.status.code(),
            reason: match output.reason {
                ExitReason::Exited => ProcessExitReason::Exited,
                ExitReason::Terminated => ProcessExitReason::Terminated,
                ExitReason::TimedOut => ProcessExitReason::Timeout,
                _ => ProcessExitReason::Unknown,
            },
            stdout: output.stdout.bytes().to_vec(),
            stderr: output.stderr.bytes().to_vec(),
            stdout_truncated: output.stdout.truncated(),
            stderr_truncated: output.stderr.truncated(),
        }
    }
}

impl From<FileType> for FileKind {
    fn from(value: FileType) -> Self {
        match value {
            FileType::File => Self::File,
            FileType::Directory => Self::Directory,
        }
    }
}
