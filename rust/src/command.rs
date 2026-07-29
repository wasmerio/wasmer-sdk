use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use bytes::Bytes;
use tokio::io::{AsyncWriteExt, DuplexStream};
#[cfg(all(target_arch = "wasm32", feature = "js"))]
use wasmer_wasix::bin_factory::BinaryPackageCommand;
use wasmer_wasix::{
    Runtime,
    bin_factory::spawn_exec,
    fs::WasiFsRoot,
    runners::wasi::{PackageOrHash, RuntimeOrEngine, WasiRunner},
};

#[cfg(feature = "sys")]
use crate::provider_fs::ProviderAdapter;
use crate::{
    CommandSelector, Error, Package, Process, ProcessExitError, ProcessStderr, ProcessStdin,
    ProcessStdout, Result, Sandbox,
    capture::{CaptureFile, CaptureHandle},
    fs::validate_guest_path,
    stream::{DuplexVirtualFile, RetainedOutput},
};

/// Live stdio configuration for [`Command::spawn`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stdio {
    /// A bounded live pipe. The application must read it; an unread pipe
    /// intentionally backpressures the guest.
    Piped,
    /// Bounded diagnostic retention with no live stream. The guest never
    /// blocks, and the retained bytes appear in the completed [`Output`].
    Capture,
    /// Discard the stream entirely.
    Null,
}

/// Why a completed process stopped executing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ExitReason {
    /// The guest exited on its own; the exit status is authoritative.
    Exited,
    /// The application terminated or killed the process through the SDK.
    Terminated,
    /// The command deadline elapsed and the SDK stopped the process.
    TimedOut,
}

impl ExitReason {
    /// The stable cross-language string for this reason.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exited => "exited",
            Self::Terminated => "terminated",
            Self::TimedOut => "timeout",
        }
    }
}

/// A subprocess-style command builder bound to a sandbox.
#[derive(Clone, Debug)]
pub struct Command {
    sandbox: Sandbox,
    selector: CommandSelector,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    current_dir: PathBuf,
    input: Bytes,
    output_bytes: Option<usize>,
    timeout: Option<Duration>,
    stdin: Stdio,
    stdout: Stdio,
    stderr: Stdio,
    stream_bytes: usize,
}

impl Command {
    pub(crate) fn new(sandbox: Sandbox, selector: CommandSelector) -> Self {
        Self {
            sandbox,
            selector,
            args: Vec::new(),
            env: BTreeMap::new(),
            current_dir: PathBuf::from("/workspace"),
            input: Bytes::new(),
            output_bytes: None,
            timeout: None,
            stdin: Stdio::Null,
            stdout: Stdio::Piped,
            stderr: Stdio::Piped,
            stream_bytes: 64 * 1024,
        }
    }

    pub fn arg(&mut self, argument: impl Into<String>) -> &mut Self {
        self.args.push(argument.into());
        self
    }

    pub fn args<I, S>(&mut self, arguments: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    pub fn env(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn current_dir(&mut self, path: impl Into<PathBuf>) -> &mut Self {
        self.current_dir = path.into();
        self
    }

    /// Provide finite stdin. EOF is delivered after these bytes.
    pub fn input(&mut self, input: impl Into<Bytes>) -> &mut Self {
        self.input = input.into();
        self
    }

    /// Override the client-wide retention bound for each output stream.
    pub fn output_bytes(&mut self, bytes: usize) -> &mut Self {
        self.output_bytes = Some(bytes);
        self
    }

    /// Stop the process once `duration` elapses.
    ///
    /// The deadline starts when the process spawns. An expired process is
    /// killed and completes with [`ExitReason::TimedOut`]; its bounded
    /// diagnostics remain available in the [`Output`].
    pub fn timeout(&mut self, duration: Duration) -> &mut Self {
        self.timeout = Some(duration);
        self
    }

    /// Configure live stdin for [`Self::spawn`].
    pub fn stdin(&mut self, mode: Stdio) -> &mut Self {
        self.stdin = mode;
        self
    }

    /// Configure live stdout for [`Self::spawn`].
    pub fn stdout(&mut self, mode: Stdio) -> &mut Self {
        self.stdout = mode;
        self
    }

    /// Configure live stderr for [`Self::spawn`].
    pub fn stderr(&mut self, mode: Stdio) -> &mut Self {
        self.stderr = mode;
        self
    }

    /// Set each live stream's bounded queue capacity.
    pub fn stream_bytes(&mut self, bytes: usize) -> &mut Self {
        self.stream_bytes = bytes.max(1);
        self
    }

    /// Run to completion and capture bounded stdout and stderr.
    ///
    /// # Errors
    ///
    /// Returns an error if the sandbox is closed, command selection fails,
    /// stdin cannot be delivered, or the guest cannot be started or executed.
    pub async fn output(&mut self) -> Result<Output> {
        let mut command = self.clone();
        command.stdin = if command.input.is_empty() {
            Stdio::Null
        } else {
            Stdio::Piped
        };
        command.stdout = Stdio::Capture;
        command.stderr = Stdio::Capture;

        let input = command.input.clone();
        let mut process = Box::pin(command.spawn()).await?;
        let stdin = process.take_stdin();

        let feed_stdin = async move {
            if let Some(mut stdin) = stdin {
                tolerate_early_exit(stdin.write_all(&input).await)?;
                tolerate_early_exit(stdin.shutdown().await)?;
            }
            Ok::<(), std::io::Error>(())
        };
        let (input_result, output) =
            Box::pin(async move { tokio::join!(feed_stdin, process.wait()) }).await;
        input_result?;
        output
    }

    /// Spawn a live process with bounded streams and diagnostic retention.
    ///
    /// Stdin defaults to [`Stdio::Null`]; stdout and stderr default to
    /// [`Stdio::Piped`]. Closing or dropping [`ProcessStdin`] delivers EOF.
    ///
    /// # Errors
    ///
    /// Returns an error if command resolution, environment construction,
    /// package mounting, compilation, or process startup fails.
    #[allow(clippy::too_many_lines)]
    pub async fn spawn(&mut self) -> Result<Process> {
        self.sandbox.ensure_open()?;
        let current_dir = validate_guest_path(&self.current_dir)?;
        let (package, command_name, packages) = self.resolve()?;
        let limit = self
            .output_bytes
            .unwrap_or(self.sandbox.inner.client.inner.output_bytes);
        let stdout_capture = CaptureHandle::new(limit);
        let stderr_capture = CaptureHandle::new(limit);

        let (guest_stdin, process_stdin) = match self.stdin {
            Stdio::Piped => {
                let (guest, user) = tokio::io::duplex(self.stream_bytes);
                (
                    Box::new(DuplexVirtualFile::new(guest))
                        as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                    Some(ProcessStdin::new(user)),
                )
            }
            Stdio::Capture | Stdio::Null => (
                Box::<virtual_fs::NullFile>::default()
                    as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                None,
            ),
        };
        let (guest_stdout, stdout_stream) =
            guest_output_file(self.stdout, &stdout_capture, self.stream_bytes);
        let (guest_stderr, stderr_stream) =
            guest_output_file(self.stderr, &stderr_capture, self.stream_bytes);
        let process_stdout = stdout_stream.map(ProcessStdout::new);
        let process_stderr = stderr_stream.map(ProcessStderr::new);

        let runtime: Arc<dyn Runtime + Send + Sync> = Arc::clone(&self.sandbox.inner.runtime);
        let mut env = self.sandbox.inner.env.clone();
        env.extend(
            self.env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        let selected = package.clone();
        let mut runner = WasiRunner::new();
        #[cfg(feature = "sys")]
        let root_fs = apply_local_package_mounts(
            &mut runner,
            &selected,
            &self.sandbox.inner.client.inner.tasks.runtime_handle(),
        )?;
        #[cfg(not(feature = "sys"))]
        let root_fs = apply_local_package_mounts(&mut runner, &selected)?;
        runner
            .with_args(self.args.clone())
            .with_envs(env)
            .with_forward_host_env(false)
            .with_current_dir(current_dir)
            .with_mount(
                "/workspace".to_owned(),
                Arc::new(self.sandbox.inner.workspace.clone()),
            )
            .with_injected_packages(
                packages
                    .into_iter()
                    .filter(|candidate| !candidate.same_as(&selected))
                    .map(|candidate| candidate.inner.binary.clone()),
            )
            .with_stdin(guest_stdin)
            .with_stdout(guest_stdout)
            .with_stderr(guest_stderr);
        #[cfg(feature = "sys")]
        for mount in &self.sandbox.inner.mounts {
            runner.with_mount(
                mount.guest_path.to_string_lossy().into_owned(),
                Arc::new(ProviderAdapter::new(
                    Arc::clone(&mount.filesystem),
                    mount.mode,
                    self.sandbox.inner.client.inner.tasks.runtime_handle(),
                )),
            );
        }

        let binary_command = selected
            .inner
            .binary
            .get_command(&command_name)
            .ok_or_else(|| Error::CommandNotFound {
                command: command_name.clone(),
            })?;
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        precompile_browser_command(runtime.as_ref(), binary_command).await?;
        let wasi = binary_command
            .metadata()
            .annotation("wasi")
            .map_err(|error| Error::Execution {
                message: format!("unable to read command metadata: {error}"),
            })?
            .unwrap_or_else(|| webc::metadata::annotations::Wasi::new(&command_name));
        let executable_name = wasi.exec_name.as_deref().unwrap_or(&command_name);
        let builder = runner
            .prepare_webc_env(
                executable_name,
                &wasi,
                PackageOrHash::Package(&selected.inner.binary),
                RuntimeOrEngine::Runtime(Arc::clone(&runtime)),
                root_fs,
            )
            .map_err(|error| Error::Execution {
                message: format!("unable to prepare the WASI environment: {error:#}"),
            })?;
        let environment = builder.build().map_err(|error| Error::Execution {
            message: format!("unable to build the WASI environment: {error}"),
        })?;
        let wasi_process = environment.process.clone();
        let task = spawn_exec(
            selected.inner.binary.clone(),
            &command_name,
            environment,
            &runtime,
        )
        .await
        .map_err(|error| Error::Execution {
            message: format!("unable to spawn the command: {error}"),
        })?;

        let tasks = Arc::clone(runtime.task_manager());
        let process = Process::new(
            wasi_process,
            Arc::clone(&tasks),
            task,
            process_stdin,
            process_stdout,
            process_stderr,
            stdout_capture,
            stderr_capture,
        );
        self.sandbox.register_process(process.control())?;

        if let Some(duration) = self.timeout {
            let handle = process.handle();
            tasks
                .task_shared(Box::new(move || {
                    Box::pin(async move {
                        handle.kill_on_timeout(duration).await;
                    })
                }))
                .map_err(|error| Error::Task {
                    message: format!("unable to schedule the command deadline: {error}"),
                })?;
        }

        Ok(process)
    }

    fn resolve(&self) -> Result<(Package, String, Vec<Package>)> {
        let packages = self
            .sandbox
            .inner
            .packages
            .read()
            .map_err(|_| Error::InternalState {
                message: "the installed-package lock is poisoned".to_owned(),
            })?
            .clone();

        let selected = match &self.selector {
            CommandSelector::Name(name) => {
                let matches: Vec<_> = packages
                    .iter()
                    .filter(|package| package.inner.binary.get_command(name).is_some())
                    .cloned()
                    .collect();
                match matches.as_slice() {
                    [] => {
                        return Err(Error::CommandNotFound {
                            command: name.clone(),
                        });
                    }
                    [package] => (package.clone(), name.clone()),
                    many => {
                        return Err(Error::CommandAmbiguous {
                            command: name.clone(),
                            packages: many.iter().map(Package::id).collect(),
                        });
                    }
                }
            }
            CommandSelector::Ref(command) => {
                let Some(package) = packages
                    .iter()
                    .find(|package| package.same_as(command.package()))
                else {
                    return Err(Error::PackageNotInstalled {
                        package: command.package().id(),
                    });
                };
                (package.clone(), command.name().to_owned())
            }
            CommandSelector::Package(requested) => {
                let Some(package) = packages.iter().find(|package| package.same_as(requested))
                else {
                    return Err(Error::PackageNotInstalled {
                        package: requested.id(),
                    });
                };
                let entrypoint = package
                    .inner
                    .binary
                    .infer_entrypoint()
                    .map_err(|_| Error::PackageHasNoEntrypoint {
                        package: package.id(),
                    })?
                    .to_owned();
                (package.clone(), entrypoint)
            }
        };
        Ok((selected.0, selected.1, packages))
    }
}

/// Browsers may reject large synchronous compilations on the window thread.
/// Prime WASIX's thread-local module cache asynchronously before handing the
/// compiled module to an execution worker. Workers and Node deliberately
/// retain the synchronous path needed by WASIX dynamic linking.
#[cfg(all(target_arch = "wasm32", feature = "js"))]
async fn precompile_browser_command(
    runtime: &(dyn Runtime + Send + Sync),
    command: &BinaryPackageCommand,
) -> Result<()> {
    use js_sys::{Uint8Array, WebAssembly};
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    if web_sys::window().is_none() {
        return Ok(());
    }

    let engine = runtime.engine();
    let cache = runtime.module_cache();
    let hash = *command.hash();
    if cache
        .contains(hash, &engine)
        .await
        .map_err(|error| Error::Execution {
            message: format!("unable to inspect the compiled-command cache: {error}"),
        })?
    {
        return Ok(());
    }

    let bytes = command.atom();
    let js_bytes = Uint8Array::from(bytes.as_ref());
    let module = JsFuture::from(WebAssembly::compile(&js_bytes))
        .await
        .map_err(|error| Error::Execution {
            message: format!(
                "unable to compile the command: {}",
                javascript_error_message(&error)
            ),
        })?
        .dyn_into::<WebAssembly::Module>()
        .map_err(|error| Error::Execution {
            message: format!(
                "browser returned an invalid compiled module: {}",
                javascript_error_message(&error)
            ),
        })?;
    let module: wasmer::Module = (module, bytes.as_ref()).into();
    cache
        .save(hash, &engine, &module)
        .await
        .map_err(|error| Error::Execution {
            message: format!("unable to cache the compiled command: {error}"),
        })
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
fn javascript_error_message(error: &wasm_bindgen::JsValue) -> String {
    error
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(error, &wasm_bindgen::JsValue::from_str("message"))
                .ok()
                .and_then(|message| message.as_string())
        })
        .unwrap_or_else(|| format!("{error:?}"))
}

/// Build the guest-side file and optional user-side stream for one output.
fn guest_output_file(
    mode: Stdio,
    capture: &CaptureHandle,
    stream_bytes: usize,
) -> (
    Box<dyn virtual_fs::VirtualFile + Send + Sync>,
    Option<DuplexStream>,
) {
    match mode {
        Stdio::Piped => {
            let (guest, user) = tokio::io::duplex(stream_bytes);
            (
                Box::new(RetainedOutput::new(guest, capture.clone())),
                Some(user),
            )
        }
        Stdio::Capture => (Box::new(CaptureFile::new(capture.clone())), None),
        Stdio::Null => (Box::<virtual_fs::NullFile>::default(), None),
    }
}

/// A guest that exits before consuming all of its stdin is not a failure:
/// `head -1`, an early crash, or a timeout all legitimately abandon input.
fn tolerate_early_exit(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::WriteZero
            ) =>
        {
            Ok(())
        }
        other => other,
    }
}

#[cfg(feature = "sys")]
fn apply_local_package_mounts(
    runner: &mut WasiRunner,
    package: &Package,
    runtime: &tokio::runtime::Handle,
) -> Result<Option<WasiFsRoot>> {
    let mappings = &package.inner.binary.additional_host_mapped_directories;
    let Some(root_mapping) = mappings.iter().find(|mapping| mapping.guest == "/") else {
        for mapping in mappings {
            let filesystem = virtual_fs::host_fs::FileSystem::new(runtime.clone(), &mapping.host)
                .map_err(|error| Error::Execution {
                message: format!(
                    "unable to mount local package directory `{}` at `{}`: {error}",
                    mapping.host.display(),
                    mapping.guest
                ),
            })?;
            runner.with_mount(mapping.guest.clone(), Arc::new(filesystem));
        }
        return Ok(None);
    };

    let root = virtual_fs::MountFileSystem::new();
    let filesystem = virtual_fs::host_fs::FileSystem::new(runtime.clone(), &root_mapping.host)
        .map_err(|error| Error::Execution {
            message: format!(
                "unable to use local package directory `{}` as the guest root: {error}",
                root_mapping.host.display()
            ),
        })?;
    let writable = Arc::new(virtual_fs::mem_fs::FileSystem::default())
        as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
    let package_files = Arc::new(filesystem) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
    let copy_on_write_root = virtual_fs::OverlayFileSystem::new(
        virtual_fs::ArcFileSystem::new(writable),
        [virtual_fs::ArcFileSystem::new(package_files)],
    );
    for path in ["/home", "/dev", "/dev/shm", "/tmp"] {
        virtual_fs::create_dir_all(&copy_on_write_root, std::path::Path::new(path)).map_err(
            |error| Error::Execution {
                message: format!("unable to create guest runtime directory `{path}`: {error}"),
            },
        )?;
    }
    for mapping in mappings.iter().filter(|mapping| mapping.guest != "/") {
        virtual_fs::create_dir_all(&copy_on_write_root, std::path::Path::new(&mapping.guest))
            .map_err(|error| Error::Execution {
                message: format!(
                    "unable to create local package mount point `{}`: {error}",
                    mapping.guest
                ),
            })?;
    }
    root.mount(std::path::Path::new("/"), Arc::new(copy_on_write_root))
        .map_err(|error| Error::Execution {
            message: format!("unable to mount the local package root: {error}"),
        })?;

    for mapping in mappings.iter().filter(|mapping| mapping.guest != "/") {
        let filesystem = virtual_fs::host_fs::FileSystem::new(runtime.clone(), &mapping.host)
            .map_err(|error| Error::Execution {
                message: format!(
                    "unable to mount local package directory `{}` at `{}`: {error}",
                    mapping.host.display(),
                    mapping.guest
                ),
            })?;
        root.mount(std::path::Path::new(&mapping.guest), Arc::new(filesystem))
            .map_err(|error| Error::Execution {
                message: format!(
                    "unable to mount local package directory `{}` at `{}`: {error}",
                    mapping.host.display(),
                    mapping.guest
                ),
            })?;
    }

    Ok(Some(WasiFsRoot::from_filesystem(Arc::new(root))))
}

#[cfg(not(feature = "sys"))]
fn apply_local_package_mounts(
    _runner: &mut WasiRunner,
    package: &Package,
) -> Result<Option<WasiFsRoot>> {
    if package
        .inner
        .binary
        .additional_host_mapped_directories
        .is_empty()
    {
        Ok(None)
    } else {
        Err(Error::CapabilityUnavailable {
            capability: "local package directory mounts",
        })
    }
}

/// A process exit status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExitStatus {
    code: i32,
}

impl ExitStatus {
    pub(crate) fn from_code(code: i32) -> Self {
        Self { code }
    }
    #[must_use]
    pub fn success(self) -> bool {
        self.code == 0
    }

    #[must_use]
    pub fn code(self) -> i32 {
        self.code
    }
}

/// Bytes captured from one completed process stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedOutput {
    bytes: Bytes,
    truncated: bool,
}

impl CapturedOutput {
    pub(crate) fn from_parts(bytes: Vec<u8>, truncated: bool) -> Self {
        Self {
            bytes: bytes.into(),
            truncated,
        }
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Decode the bytes synchronously.
    ///
    /// # Errors
    ///
    /// Returns an error when the captured bytes are not valid UTF-8.
    pub fn text(&self) -> Result<String> {
        Ok(String::from_utf8(self.bytes.to_vec())?)
    }

    #[must_use]
    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

/// A completed command and its captured output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Output {
    pub status: ExitStatus,
    /// Why the process stopped: its own exit, SDK termination, or a timeout.
    pub reason: ExitReason,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

impl Output {
    /// True only when the guest exited on its own with a zero status.
    #[must_use]
    pub fn ok(&self) -> bool {
        self.reason == ExitReason::Exited && self.status.success()
    }

    /// Convert an unsuccessful completion into a typed error.
    ///
    /// # Errors
    ///
    /// Returns [`ProcessExitError`] when the process did not exit successfully,
    /// including termination and timeout outcomes.
    pub fn check(self) -> Result<Self> {
        if self.ok() {
            Ok(self)
        } else {
            Err(ProcessExitError::new(self).into())
        }
    }

    /// Check success and synchronously decode stdout.
    ///
    /// # Errors
    ///
    /// Returns [`ProcessExitError`] for an unsuccessful completion or a UTF-8
    /// error when stdout is not valid UTF-8.
    pub fn text(&self) -> Result<String> {
        if !self.ok() {
            return Err(ProcessExitError::new(self.clone()).into());
        }
        self.stdout.text()
    }
}

#[cfg(test)]
mod tests {
    use super::{CapturedOutput, ExitReason, ExitStatus, Output};

    #[test]
    fn text_is_synchronous_and_checked() {
        let output = Output {
            status: ExitStatus { code: 0 },
            reason: ExitReason::Exited,
            stdout: CapturedOutput::from_parts(b"hello".to_vec(), false),
            stderr: CapturedOutput::from_parts(Vec::new(), false),
        };
        assert_eq!(output.text().unwrap(), "hello");
    }

    #[test]
    fn checked_output_preserves_nonzero_result() {
        let output = Output {
            status: ExitStatus { code: 7 },
            reason: ExitReason::Exited,
            stdout: CapturedOutput::from_parts(b"partial".to_vec(), false),
            stderr: CapturedOutput::from_parts(b"failed".to_vec(), false),
        };
        let error = output.check().unwrap_err();
        let crate::Error::ProcessExit(error) = error else {
            panic!("expected process exit error");
        };
        assert_eq!(error.output().status.code(), 7);
        assert_eq!(error.output().stdout.bytes(), b"partial");
    }

    #[test]
    fn terminated_output_is_not_ok_even_with_zero_status() {
        let output = Output {
            status: ExitStatus { code: 0 },
            reason: ExitReason::Terminated,
            stdout: CapturedOutput::from_parts(Vec::new(), false),
            stderr: CapturedOutput::from_parts(Vec::new(), false),
        };
        assert!(!output.ok());
        assert!(output.check().is_err());
    }

    #[test]
    fn exit_error_includes_stderr_excerpt() {
        let output = Output {
            status: ExitStatus { code: 1 },
            reason: ExitReason::Exited,
            stdout: CapturedOutput::from_parts(Vec::new(), false),
            stderr: CapturedOutput::from_parts(b"boom: missing file".to_vec(), false),
        };
        let message = output.check().unwrap_err().to_string();
        assert!(message.contains("status 1"), "{message}");
        assert!(message.contains("boom: missing file"), "{message}");
    }
}
