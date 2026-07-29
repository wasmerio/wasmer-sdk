use std::{io, path::PathBuf, string::FromUtf8Error};

use thiserror::Error;

use crate::{ExitReason, Output};

/// The result type returned by the SDK.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// An SDK operation failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    #[error("the Wasmer client is shut down")]
    ClientClosed,

    #[error("the sandbox is closed")]
    SandboxClosed,

    #[error("invalid package source `{package_source}`: {message}")]
    InvalidPackageSource {
        package_source: String,
        message: String,
    },

    #[error("unable to load package `{package_source}`: {message}")]
    PackageLoad {
        package_source: String,
        message: String,
    },

    #[error("package `{package}` is not installed in this sandbox")]
    PackageNotInstalled { package: String },

    #[error("package `{package}` has no unambiguous entrypoint")]
    PackageHasNoEntrypoint { package: String },

    #[error("command `{command}` was not found in the installed packages")]
    CommandNotFound { command: String },

    #[error("command `{command}` is ambiguous; it is provided by {packages:?}")]
    CommandAmbiguous {
        command: String,
        packages: Vec<String>,
    },

    #[error("capability `{capability}` is unavailable on this target")]
    CapabilityUnavailable { capability: &'static str },

    #[error("invalid guest path `{path}`: {message}")]
    InvalidGuestPath { path: PathBuf, message: String },

    #[error("filesystem operation `{operation}` failed for `{path}`: {message}")]
    FileSystem {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },

    #[error("timed out waiting for {operation}")]
    Timeout { operation: String },

    #[error("command execution failed: {message}")]
    Execution { message: String },

    #[error("command task failed: {message}")]
    Task { message: String },

    #[error("internal SDK state is unavailable: {message}")]
    InternalState { message: String },

    #[error(transparent)]
    ExternalFileSystem(#[from] crate::FsError),

    #[error("stream I/O failed")]
    Io(#[from] io::Error),

    #[error(transparent)]
    ProcessExit(#[from] ProcessExitError),

    #[error("captured output is not valid UTF-8")]
    Utf8(#[from] FromUtf8Error),

    #[error("unable to initialize the SDK: {message}")]
    Initialization { message: String },
}

impl Error {
    /// The current machine-readable error code shared by language bindings.
    ///
    /// This taxonomy is provisional while the SDK is pre-1.0. Consumers can
    /// branch on it today, but should expect codes to be refined before the
    /// cross-language contract is declared stable.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::ClientClosed => "CLIENT_CLOSED",
            Self::SandboxClosed => "SANDBOX_CLOSED",
            Self::InvalidPackageSource { .. } => "INVALID_PACKAGE_SOURCE",
            Self::PackageLoad { .. } => "PACKAGE_LOAD_FAILED",
            Self::PackageNotInstalled { .. } => "PACKAGE_NOT_INSTALLED",
            Self::PackageHasNoEntrypoint { .. } => "PACKAGE_HAS_NO_ENTRYPOINT",
            Self::CommandNotFound { .. } => "COMMAND_NOT_FOUND",
            Self::CommandAmbiguous { .. } => "COMMAND_AMBIGUOUS",
            Self::CapabilityUnavailable { .. } => "CAPABILITY_UNAVAILABLE",
            Self::InvalidGuestPath { .. } => "INVALID_PATH",
            Self::FileSystem { .. } | Self::ExternalFileSystem(_) => "FILESYSTEM_ERROR",
            Self::Timeout { .. } => "TIMEOUT",
            Self::ProcessExit(error) => error.code(),
            Self::Utf8(_) => "INVALID_UTF8",
            Self::Execution { .. } => "EXECUTION_ERROR",
            Self::Task { .. } => "TASK_ERROR",
            Self::InternalState { .. } => "INTERNAL_ERROR",
            Self::Io(_) => "IO_ERROR",
            Self::Initialization { .. } => "INITIALIZATION_ERROR",
        }
    }
}

/// A checked command completed unsuccessfully.
///
/// The display message names the termination reason and includes a bounded
/// excerpt of retained stderr so failures are diagnosable without manual
/// stream plumbing. The complete [`Output`] remains available.
#[derive(Debug, Error)]
#[error("{}", self.describe())]
pub struct ProcessExitError {
    output: Box<Output>,
}

/// Longest stderr excerpt included in the display message.
const STDERR_EXCERPT_BYTES: usize = 512;

impl ProcessExitError {
    pub(crate) fn new(output: Output) -> Self {
        Self {
            output: Box::new(output),
        }
    }

    /// The current machine-readable error code for this failure.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self.output.reason {
            ExitReason::Exited => "PROCESS_EXITED",
            ExitReason::Terminated => "PROCESS_TERMINATED",
            ExitReason::TimedOut => "TIMEOUT",
        }
    }

    /// The complete captured result of the process.
    #[must_use]
    pub fn output(&self) -> &Output {
        &self.output
    }

    /// Recover ownership of the complete captured result.
    #[must_use]
    pub fn into_output(self) -> Output {
        *self.output
    }

    fn describe(&self) -> String {
        let base = match self.output.reason {
            ExitReason::Exited => format!(
                "process exited unsuccessfully with status {}",
                self.output.status.code()
            ),
            ExitReason::Terminated => "process was terminated before completing".to_owned(),
            ExitReason::TimedOut => "process timed out".to_owned(),
        };
        let stderr = self.output.stderr.bytes();
        let start = stderr.len().saturating_sub(STDERR_EXCERPT_BYTES);
        let excerpt = String::from_utf8_lossy(&stderr[start..]);
        let excerpt = excerpt.trim();
        if excerpt.is_empty() {
            base
        } else {
            let ellipsis = if start > 0 { "…" } else { "" };
            format!("{base}\nstderr: {ellipsis}{excerpt}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn operational_failures_have_distinct_provisional_codes() {
        let package = Error::PackageLoad {
            package_source: "example/package".to_owned(),
            message: "registry unavailable".to_owned(),
        };
        let execution = Error::Execution {
            message: "runner failed".to_owned(),
        };
        let task = Error::Task {
            message: "worker failed".to_owned(),
        };
        let internal = Error::InternalState {
            message: "state missing".to_owned(),
        };
        let io = Error::Io(std::io::Error::other("stream failed"));
        let initialization = Error::Initialization {
            message: "runtime failed".to_owned(),
        };

        assert_eq!(package.code(), "PACKAGE_LOAD_FAILED");
        assert_eq!(execution.code(), "EXECUTION_ERROR");
        assert_eq!(task.code(), "TASK_ERROR");
        assert_eq!(internal.code(), "INTERNAL_ERROR");
        assert_eq!(io.code(), "IO_ERROR");
        assert_eq!(initialization.code(), "INITIALIZATION_ERROR");
    }
}
