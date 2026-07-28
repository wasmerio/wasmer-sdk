use std::{io, path::PathBuf, string::FromUtf8Error};

use thiserror::Error;

use crate::Output;

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

/// A checked command completed with an unsuccessful exit status.
#[derive(Debug, Error)]
#[error("process exited unsuccessfully with status {status}")]
pub struct ProcessExitError {
    status: i32,
    output: Box<Output>,
}

impl ProcessExitError {
    pub(crate) fn new(output: Output) -> Self {
        Self {
            status: output.status.code(),
            output: Box::new(output),
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
}
