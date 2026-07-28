#[cfg(feature = "sys")]
use std::borrow::Cow;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(feature = "sys")]
use wasmer_wasix::runtime::ModuleInput;
#[cfg(feature = "sys")]
use wasmer_wasix::virtual_net::host::LocalNetworking;
use wasmer_wasix::{
    Runtime, UnsupportedVirtualNetworking,
    bin_factory::spawn_exec,
    fs::WasiFsRoot,
    runners::wasi::{PackageOrHash, RuntimeOrEngine, WasiRunner},
    runtime::OverriddenRuntime,
};

#[cfg(feature = "sys")]
use crate::provider_fs::ProviderAdapter;
use crate::{
    CommandSelector, Error, NetworkPolicy, Package, Process, ProcessExitError, ProcessStderr,
    ProcessStdin, ProcessStdout, Result, Sandbox,
    capture::BoundedCapture,
    fs::validate_guest_path,
    stream::{DuplexVirtualFile, RetainedOutput},
};

/// Live stdio configuration for [`Command::spawn`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stdio {
    Piped,
    Null,
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
    /// stdin cannot be prepared, or the guest cannot be started or executed.
    pub async fn output(&mut self) -> Result<Output> {
        let mut command = self.clone();
        command.stdin = if command.input.is_empty() {
            Stdio::Null
        } else {
            Stdio::Piped
        };
        command.stdout = Stdio::Piped;
        command.stderr = Stdio::Piped;

        let input = command.input.clone();
        let mut process = Box::pin(command.spawn()).await?;
        let stdin = process.take_stdin();
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();

        let feed_stdin = async move {
            if let Some(mut stdin) = stdin {
                stdin.write_all(&input).await?;
                stdin.shutdown().await?;
            }
            Ok::<(), std::io::Error>(())
        };
        let drain_stdout = drain_stream(stdout);
        let drain_stderr = drain_stream(stderr);
        let (input_result, stdout_result, stderr_result, output) = Box::pin(async move {
            tokio::join!(feed_stdin, drain_stdout, drain_stderr, process.wait())
        })
        .await;
        input_result?;
        stdout_result?;
        stderr_result?;
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
        let (_, stdout_capture) = BoundedCapture::new(limit);
        let (_, stderr_capture) = BoundedCapture::new(limit);

        let (guest_stdin, process_stdin) = match self.stdin {
            Stdio::Piped => {
                let (guest, user) = tokio::io::duplex(self.stream_bytes);
                (
                    Box::new(DuplexVirtualFile::new(guest))
                        as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                    Some(ProcessStdin::new(user)),
                )
            }
            Stdio::Null => (
                Box::<virtual_fs::NullFile>::default()
                    as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                None,
            ),
        };
        let (guest_stdout, process_stdout) = match self.stdout {
            Stdio::Piped => {
                let (guest, user) = tokio::io::duplex(self.stream_bytes);
                (
                    Box::new(RetainedOutput::new(guest, stdout_capture.clone(), limit))
                        as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                    Some(ProcessStdout::new(user)),
                )
            }
            Stdio::Null => (
                Box::<virtual_fs::NullFile>::default()
                    as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                None,
            ),
        };
        let (guest_stderr, process_stderr) = match self.stderr {
            Stdio::Piped => {
                let (guest, user) = tokio::io::duplex(self.stream_bytes);
                (
                    Box::new(RetainedOutput::new(guest, stderr_capture.clone(), limit))
                        as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                    Some(ProcessStderr::new(user)),
                )
            }
            Stdio::Null => (
                Box::<virtual_fs::NullFile>::default()
                    as Box<dyn virtual_fs::VirtualFile + Send + Sync>,
                None,
            ),
        };

        let runtime = sandbox_runtime(&self.sandbox);
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
            .with_envs(self.env.clone())
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

        let process = Process::new(
            wasi_process,
            task,
            process_stdin,
            process_stdout,
            process_stderr,
            stdout_capture,
            stderr_capture,
        );
        self.sandbox.register_process(process.control())?;
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

async fn drain_stream<S>(stream: Option<S>) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + Unpin,
{
    if let Some(mut stream) = stream {
        let mut scratch = [0_u8; 8192];
        while stream.read(&mut scratch).await? != 0 {}
    }
    Ok(())
}

fn sandbox_runtime(sandbox: &Sandbox) -> Arc<dyn Runtime + Send + Sync> {
    let base: Arc<dyn Runtime + Send + Sync> =
        Arc::clone(&sandbox.inner.client.inner.runtime) as Arc<_>;
    let networking = match sandbox.inner.network {
        NetworkPolicy::Disabled => Arc::new(UnsupportedVirtualNetworking::default()) as Arc<_>,
        NetworkPolicy::Host => host_networking(&base),
    };
    let runtime: Arc<dyn Runtime + Send + Sync> =
        Arc::new(OverriddenRuntime::new(base).with_networking(networking));
    let runtime_for_resolver = Arc::clone(&runtime);
    let hooks =
        wasmer_c_api_imports::WasmCapiRuntimeHooks::new().with_resolve_module_sync(move |bytes| {
            resolve_capi_module(runtime_for_resolver.as_ref(), bytes)
        });

    Arc::new(
        OverriddenRuntime::new(runtime)
            .with_additional_imports({
                let hooks = hooks.clone();
                move |module, store| hooks.additional_imports(module, store)
            })
            .with_instance_setup(move |module, store, instance, imported_memory| {
                hooks.configure_instance(module, store, instance, imported_memory)
            }),
    )
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
fn host_networking(
    _base: &Arc<dyn Runtime + Send + Sync>,
) -> wasmer_wasix::virtual_net::DynVirtualNetworking {
    Arc::new(LocalNetworking::default())
}

#[cfg(not(feature = "sys"))]
fn host_networking(
    base: &Arc<dyn Runtime + Send + Sync>,
) -> wasmer_wasix::virtual_net::DynVirtualNetworking {
    Arc::clone(base.networking())
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
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

impl Output {
    /// Convert an unsuccessful exit status into a typed error.
    ///
    /// # Errors
    ///
    /// Returns [`ProcessExitError`] when the process did not exit successfully.
    pub fn check(self) -> Result<Self> {
        if self.status.success() {
            Ok(self)
        } else {
            Err(ProcessExitError::new(self).into())
        }
    }

    /// Check success and synchronously decode stdout.
    ///
    /// # Errors
    ///
    /// Returns [`ProcessExitError`] for an unsuccessful status or a UTF-8 error
    /// when stdout is not valid UTF-8.
    pub fn text(&self) -> Result<String> {
        if !self.status.success() {
            return Err(ProcessExitError::new(self.clone()).into());
        }
        self.stdout.text()
    }
}

#[cfg(test)]
mod tests {
    use super::{CapturedOutput, ExitStatus, Output};

    #[test]
    fn text_is_synchronous_and_checked() {
        let output = Output {
            status: ExitStatus { code: 0 },
            stdout: CapturedOutput::from_parts(b"hello".to_vec(), false),
            stderr: CapturedOutput::from_parts(Vec::new(), false),
        };
        assert_eq!(output.text().unwrap(), "hello");
    }

    #[test]
    fn checked_output_preserves_nonzero_result() {
        let output = Output {
            status: ExitStatus { code: 7 },
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
}
