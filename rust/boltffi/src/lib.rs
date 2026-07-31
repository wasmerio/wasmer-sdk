#![allow(
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::used_underscore_items
)]

mod error;
mod runtime;

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use boltffi::{data, export};
pub use error::SdkError;
use runtime::RuntimeContext;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::{
    Command as SdkCommand, ExitReason as SdkExitReason, FileType, NetworkPolicy,
    Output as SdkOutput, Package as SdkPackage, PackageSource, Process as SdkProcess,
    ProcessHandle, ProcessStderr, ProcessStdin, ProcessStdout, Sandbox as SdkSandbox,
    SandboxFileSystem as SdkSandboxFileSystem, Stdio, Wasmer as SdkWasmer, WasmerConfig,
};

const DEFAULT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;

#[data]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum NetworkMode {
    Disabled = 0,
    Host = 1,
}

#[data]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum InputMode {
    Closed = 0,
    Pipe = 1,
}

#[data]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum OutputMode {
    Pipe = 0,
    Capture = 1,
    Discard = 2,
}

#[data]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum ProcessExitReason {
    Exited = 0,
    Terminated = 1,
    Timeout = 2,
    Unknown = 3,
}

#[data]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum FileKind {
    File = 0,
    Directory = 1,
}

#[data]
#[derive(Clone, Debug)]
pub struct RunOptions {
    pub input: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
    pub output_bytes: Option<u64>,
}

#[data]
#[derive(Clone, Debug)]
pub struct SpawnOptions {
    pub timeout_ms: Option<u64>,
    pub output_bytes: Option<u64>,
    pub stdin: InputMode,
    pub stdout: OutputMode,
    pub stderr: OutputMode,
}

#[data]
#[derive(Clone, Debug)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub reason: ProcessExitReason,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[data]
#[derive(Clone, Debug)]
pub struct FileStat {
    pub kind: FileKind,
    pub size: u64,
}

#[data]
#[derive(Clone, Debug)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
}

#[derive(Debug)]
pub struct Wasmer {
    context: Arc<RuntimeContext>,
    inner: SdkWasmer,
}

#[export]
impl Wasmer {
    pub fn new(cache_root: Option<String>, output_bytes: Option<u64>) -> Result<Self, String> {
        let context = RuntimeContext::new()?;
        let output_bytes =
            checked_usize("output_bytes", output_bytes.unwrap_or(DEFAULT_OUTPUT_BYTES))?;
        let mut config = WasmerConfig {
            output_bytes,
            ..WasmerConfig::default()
        };
        if let Some(cache_root) = cache_root {
            config.cache.root = PathBuf::from(cache_root);
        }
        let inner = {
            let _guard = context.enter();
            SdkWasmer::with_config(config).map_err(SdkError::from)?
        };
        Ok(Self { context, inner })
    }

    pub async fn load_package_registry(&self, specifier: String) -> Result<Package, String> {
        let client = self.inner.clone();
        let package = self
            .context
            .sdk(async move { client.packages().load(specifier).await })
            .await?;
        Ok(Package::new(Arc::clone(&self.context), package))
    }

    pub async fn load_package_path(&self, path: String) -> Result<Package, String> {
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
        Ok(Package::new(Arc::clone(&self.context), package))
    }

    pub async fn load_package_bytes(&self, bytes: Vec<u8>) -> Result<Package, String> {
        let client = self.inner.clone();
        let package = self
            .context
            .sdk(async move { client.packages().load(PackageSource::webc(bytes)).await })
            .await?;
        Ok(Package::new(Arc::clone(&self.context), package))
    }

    pub async fn create_sandbox(
        &self,
        registry_packages: Vec<String>,
        files: HashMap<String, Vec<u8>>,
        env: HashMap<String, String>,
        network: NetworkMode,
    ) -> Result<Sandbox, String> {
        let client = self.inner.clone();
        let sandbox = self
            .context
            .sdk(async move {
                let mut builder = client.sandboxes().create().network(network.into());
                for specifier in registry_packages {
                    let package = client.packages().load(specifier).await?;
                    builder = builder.package(package);
                }
                for (path, contents) in files {
                    builder = builder.file(path, contents);
                }
                for (key, value) in env {
                    builder = builder.env(key, value);
                }
                builder.await
            })
            .await?;
        Ok(Sandbox::new(Arc::clone(&self.context), sandbox))
    }

    pub async fn close(&self) -> Result<(), String> {
        let client = self.inner.clone();
        self.context
            .sdk(async move { client.shutdown().await })
            .await
            .map_err(Into::into)
    }
}

#[derive(Debug)]
pub struct Package {
    _context: Arc<RuntimeContext>,
    inner: SdkPackage,
}

impl Package {
    fn new(context: Arc<RuntimeContext>, inner: SdkPackage) -> Self {
        Self {
            _context: context,
            inner,
        }
    }
}

#[export]
impl Package {
    pub fn id(&self) -> String {
        self.inner.id()
    }

    pub fn commands(&self) -> Vec<String> {
        self.inner.commands()
    }

    pub fn entrypoint(&self) -> Option<String> {
        self.inner.entrypoint()
    }
}

#[derive(Debug)]
pub struct Sandbox {
    context: Arc<RuntimeContext>,
    inner: SdkSandbox,
}

impl Sandbox {
    fn new(context: Arc<RuntimeContext>, inner: SdkSandbox) -> Self {
        Self { context, inner }
    }

    fn configure_command(
        &self,
        mut command: SdkCommand,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Command {
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        Command {
            context: Arc::clone(&self.context),
            inner: command,
        }
    }
}

#[export]
impl Sandbox {
    pub fn command(
        &self,
        name: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Command {
        self.configure_command(self.inner.command(name), args, cwd, env)
    }

    pub fn command_package(
        &self,
        package: &Package,
        args: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Command {
        self.configure_command(self.inner.command(package.inner.clone()), args, cwd, env)
    }

    pub async fn install_package_registry(&self, specifier: String) -> Result<Package, String> {
        self.install(PackageSource::registry(specifier))
            .await
            .map_err(Into::into)
    }

    pub async fn install_package_path(&self, path: String) -> Result<Package, String> {
        self.install(PackageSource::path(PathBuf::from(path)))
            .await
            .map_err(Into::into)
    }

    pub async fn install_package_bytes(&self, bytes: Vec<u8>) -> Result<Package, String> {
        self.install(PackageSource::webc(bytes))
            .await
            .map_err(Into::into)
    }

    pub fn filesystem(&self) -> SandboxFileSystem {
        SandboxFileSystem {
            context: Arc::clone(&self.context),
            inner: self.inner.fs().clone(),
        }
    }

    pub fn ports(&self) -> Ports {
        Ports {
            context: Arc::clone(&self.context),
            inner: self.inner.ports(),
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        let sandbox = self.inner.clone();
        self.context
            .sdk(async move { sandbox.close().await })
            .await
            .map_err(Into::into)
    }
}

impl Sandbox {
    async fn install(&self, source: PackageSource) -> Result<Package, SdkError> {
        let sandbox = self.inner.clone();
        let package = self
            .context
            .sdk(async move { sandbox.install_package(source).await })
            .await?;
        Ok(Package::new(Arc::clone(&self.context), package))
    }
}

#[derive(Debug)]
pub struct Command {
    context: Arc<RuntimeContext>,
    inner: SdkCommand,
}

#[export]
impl Command {
    pub async fn run(&self, options: RunOptions) -> Result<ProcessOutput, String> {
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

    pub async fn spawn(&self, options: SpawnOptions) -> Result<Process, String> {
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
        Ok(Process {
            context: Arc::clone(&self.context),
            id: process.id(),
            handle,
            child: Arc::new(tokio::sync::Mutex::new(process)),
            stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
            stdout: Arc::new(tokio::sync::Mutex::new(stdout)),
            stderr: Arc::new(tokio::sync::Mutex::new(stderr)),
            has_stdin: options.stdin == InputMode::Pipe,
            has_stdout: options.stdout == OutputMode::Pipe,
            has_stderr: options.stderr == OutputMode::Pipe,
        })
    }
}

#[derive(Debug)]
pub struct Process {
    context: Arc<RuntimeContext>,
    id: u32,
    handle: ProcessHandle,
    child: Arc<tokio::sync::Mutex<SdkProcess>>,
    stdin: Arc<tokio::sync::Mutex<Option<ProcessStdin>>>,
    stdout: Arc<tokio::sync::Mutex<Option<ProcessStdout>>>,
    stderr: Arc<tokio::sync::Mutex<Option<ProcessStderr>>>,
    has_stdin: bool,
    has_stdout: bool,
    has_stderr: bool,
}

#[export]
impl Process {
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

    pub async fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String> {
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
            .map_err(Into::into)
    }

    pub async fn close_stdin(&self) -> Result<(), String> {
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
            .map_err(Into::into)
    }

    pub async fn read_stdout(&self, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
        read_stream(
            Arc::clone(&self.context),
            Arc::clone(&self.stdout),
            checked_read_size(max_bytes)?,
        )
        .await
        .map_err(Into::into)
    }

    pub async fn read_stderr(&self, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
        read_stream(
            Arc::clone(&self.context),
            Arc::clone(&self.stderr),
            checked_read_size(max_bytes)?,
        )
        .await
        .map_err(Into::into)
    }

    pub async fn wait(&self) -> Result<ProcessOutput, String> {
        let process = Arc::clone(&self.child);
        self.context
            .sdk(async move { process.lock().await.wait().await })
            .await
            .map(ProcessOutput::from)
            .map_err(Into::into)
    }

    pub async fn terminate(&self, grace_ms: u64) -> Result<(), String> {
        let handle = self.handle.clone();
        self.context
            .sdk(async move {
                handle.terminate(Duration::from_millis(grace_ms)).await;
                Ok(())
            })
            .await
            .map_err(Into::into)
    }

    pub fn kill(&self) {
        self.handle.kill();
    }
}

#[derive(Debug)]
pub struct SandboxFileSystem {
    context: Arc<RuntimeContext>,
    inner: SdkSandboxFileSystem,
}

#[export]
impl SandboxFileSystem {
    pub async fn write(&self, path: String, bytes: Vec<u8>) -> Result<(), String> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.write(path, bytes).await })
            .await
            .map_err(Into::into)
    }

    pub async fn read(&self, path: String) -> Result<Vec<u8>, String> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.read(path).await })
            .await
            .map_err(Into::into)
    }

    pub async fn mkdir(&self, path: String, recursive: bool) -> Result<(), String> {
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
            .map_err(Into::into)
    }

    pub async fn read_dir(&self, path: String) -> Result<Vec<DirectoryEntry>, String> {
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

    pub async fn stat(&self, path: String) -> Result<FileStat, String> {
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

    pub async fn remove(&self, path: String, recursive: bool) -> Result<(), String> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.remove(path, recursive) })
            .await
            .map_err(Into::into)
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), String> {
        let filesystem = self.inner.clone();
        self.context
            .sdk(async move { filesystem.rename(from, to).await })
            .await
            .map_err(Into::into)
    }
}

#[derive(Debug)]
pub struct Ports {
    context: Arc<RuntimeContext>,
    inner: wasmer_sdk::Ports,
}

#[export]
impl Ports {
    pub async fn wait(&self, port: u16, timeout_ms: u64) -> Result<(), String> {
        if port == 0 {
            return Err(SdkError::invalid_argument("`port` must be between 1 and 65535").into());
        }
        let ports = self.inner.clone();
        self.context
            .sdk(async move { ports.wait(port, Duration::from_millis(timeout_ms)).await })
            .await
            .map_err(Into::into)
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
    command: &mut SdkCommand,
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

impl From<SdkOutput> for ProcessOutput {
    fn from(output: SdkOutput) -> Self {
        Self {
            exit_code: output.status.code(),
            reason: match output.reason {
                SdkExitReason::Exited => ProcessExitReason::Exited,
                SdkExitReason::Terminated => ProcessExitReason::Terminated,
                SdkExitReason::TimedOut => ProcessExitReason::Timeout,
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
