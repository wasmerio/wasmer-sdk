use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use bytes::Bytes;
use virtual_fs::{AsyncSeekExt, AsyncWriteExt};
use wasmer_wasix::{
    WasiError,
    runners::wasi::{RuntimeOrEngine, WasiRunner},
};

use crate::{
    CommandSelector, Error, Package, ProcessExitError, Result, Sandbox, capture::BoundedCapture,
    fs::validate_guest_path,
};

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

    /// Run to completion and capture bounded stdout and stderr.
    ///
    /// # Errors
    ///
    /// Returns an error if the sandbox is closed, command selection fails,
    /// stdin cannot be prepared, or the guest cannot be started or executed.
    pub async fn output(&mut self) -> Result<Output> {
        self.sandbox.ensure_open()?;
        let current_dir = validate_guest_path(&self.current_dir)?;
        let (package, command_name, packages) = self.resolve()?;
        let limit = self
            .output_bytes
            .unwrap_or(self.sandbox.inner.client.inner.output_bytes);

        let mut stdin = virtual_fs::BufferFile::default();
        stdin
            .write_all(&self.input)
            .await
            .map_err(|error| Error::Execution {
                message: format!("unable to prepare stdin: {error}"),
            })?;
        stdin.rewind().await.map_err(|error| Error::Execution {
            message: format!("unable to rewind stdin: {error}"),
        })?;

        let (stdout, stdout_handle) = BoundedCapture::new(limit);
        let (stderr, stderr_handle) = BoundedCapture::new(limit);
        let args = self.args.clone();
        let env = self.env.clone();
        let runtime = Arc::clone(&self.sandbox.inner.client.inner.runtime);
        let tasks = Arc::clone(&self.sandbox.inner.client.inner.tasks);
        let workspace = self.sandbox.inner.workspace.clone();
        let selected = package.clone();

        let task = tokio::task::spawn_blocking(move || {
            let _runtime_guard = tasks.runtime_handle().enter();
            let mut runner = WasiRunner::new();
            runner
                .with_args(args)
                .with_envs(env)
                .with_forward_host_env(false)
                .with_current_dir(current_dir)
                .with_mount("/workspace".to_owned(), Arc::new(workspace))
                .with_injected_packages(
                    packages
                        .into_iter()
                        .filter(|candidate| !candidate.same_as(&selected))
                        .map(|candidate| candidate.inner.binary.clone()),
                )
                .with_stdin(Box::new(stdin))
                .with_stdout(Box::new(stdout))
                .with_stderr(Box::new(stderr));

            runner.run_command(
                &command_name,
                &selected.inner.binary,
                RuntimeOrEngine::Runtime(runtime),
            )
        })
        .await
        .map_err(|error| Error::Task {
            message: error.to_string(),
        })?;

        let status = match task {
            Ok(()) => ExitStatus { code: 0 },
            Err(error) => {
                if let Some(WasiError::Exit(code)) = error
                    .chain()
                    .find_map(|cause| cause.downcast_ref::<WasiError>())
                {
                    ExitStatus { code: code.raw() }
                } else {
                    return Err(Error::Execution {
                        message: format!("{error:#}"),
                    });
                }
            }
        };
        let (stdout, stdout_truncated) = stdout_handle.snapshot();
        let (stderr, stderr_truncated) = stderr_handle.snapshot();

        Ok(Output {
            status,
            stdout: CapturedOutput::new(stdout, stdout_truncated),
            stderr: CapturedOutput::new(stderr, stderr_truncated),
        })
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

/// A process exit status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExitStatus {
    code: i32,
}

impl ExitStatus {
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
    fn new(bytes: Vec<u8>, truncated: bool) -> Self {
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
            stdout: CapturedOutput::new(b"hello".to_vec(), false),
            stderr: CapturedOutput::new(Vec::new(), false),
        };
        assert_eq!(output.text().unwrap(), "hello");
    }

    #[test]
    fn checked_output_preserves_nonzero_result() {
        let output = Output {
            status: ExitStatus { code: 7 },
            stdout: CapturedOutput::new(b"partial".to_vec(), false),
            stderr: CapturedOutput::new(b"failed".to_vec(), false),
        };
        let error = output.check().unwrap_err();
        let crate::Error::ProcessExit(error) = error else {
            panic!("expected process exit error");
        };
        assert_eq!(error.output().status.code(), 7);
        assert_eq!(error.output().stdout.bytes(), b"partial");
    }
}
