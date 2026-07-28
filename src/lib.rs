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
mod sandbox;

pub use client::{CacheConfig, Wasmer, WasmerConfig};
pub use command::{CapturedOutput, Command, ExitStatus, Output};
pub use error::{Error, ProcessExitError, Result};
pub use fs::SandboxFileSystem;
pub use package::{CommandRef, CommandSelector, Package, PackageSource};
pub use sandbox::{Sandbox, SandboxBuilder};
