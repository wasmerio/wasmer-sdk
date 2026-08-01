//! A package-first sandbox SDK powered by Wasmer.
//!
//! The SDK deliberately has no client-level `run()` shortcut. A [`Sandbox`]
//! owns package composition, a persistent workspace, and command execution.

mod capture;
mod client;
mod command;
mod error;
mod fs;
mod package;
mod process;
mod provider_fs;
mod sandbox;
mod stream;
mod terminal;

pub use client::{CacheConfig, Packages, Sandboxes, Wasmer, WasmerConfig};
pub use command::{CapturedOutput, Command, ExitReason, ExitStatus, Output, Stdio};
pub use error::{Error, ProcessExitError, Result};
pub use fs::SandboxFileSystem;
pub use package::{CommandRef, CommandSelector, Package, PackageSource};
pub use process::{Process, ProcessHandle, ProcessStderr, ProcessStdin, ProcessStdout};
pub use provider_fs::{
    Directory, DirectoryEntry, File, FileMetadata, FileOpenOptions, FileSystem,
    FileSystemCapabilities, FileType, FsError, FsResult, MountMode, RelativePath,
};
pub use sandbox::{IntoFileSystem, NetworkPolicy, Ports, Sandbox, SandboxBuilder};
pub use terminal::TerminalOptions;
