use std::path::Path;

use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, PackageSource, Result, Wasmer, WasmerConfig};

const ECHO_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 4096))
    (drop
      (call $fd_read
        (i32.const 0)
        (i32.const 0)
        (i32.const 1)
        (i32.const 8)))
    (i32.store (i32.const 4) (i32.load (i32.const 8)))
    (drop
      (call $fd_write
        (i32.const 1)
        (i32.const 0)
        (i32.const 1)
        (i32.const 12)))))
"#;

const ENV_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get"
    (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $environ_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $environ_get (i32.const 16) (i32.const 1024)))
    (i32.store (i32.const 8) (i32.const 1024))
    (i32.store (i32.const 12) (i32.load (i32.const 4)))
    (drop
      (call $fd_write
        (i32.const 1)
        (i32.const 8)
        (i32.const 1)
        (i32.const 24)))))
"#;

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_local_package_with_finite_stdio_and_a_persistent_workspace() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_echo_package(fixture.path());

    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client
        .sandboxes()
        .create()
        .package(PackageSource::path(fixture.path()))
        .file("seed.txt", b"persistent".to_vec())
        .await?;

    let output = sandbox
        .command("echo")
        .input("hello from stdin")
        .output()
        .await?;

    assert!(output.status.success());
    assert_eq!(output.stdout.bytes(), b"hello from stdin");
    assert_eq!(output.text()?, "hello from stdin");
    assert_eq!(
        sandbox.fs().read_text("/workspace/seed.txt").await?,
        "persistent"
    );
    assert!(state.path().join(".wasmer/cache-v1/packages").is_dir());
    assert!(state.path().join(".wasmer/cache-v1/compiled").is_dir());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_after_creation_and_selects_a_package_entrypoint() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_echo_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client.sandboxes().create().await?;

    let echo = sandbox
        .install_package(PackageSource::path(fixture.path()))
        .await?;
    let echo_again = sandbox
        .install_package(PackageSource::path(fixture.path()))
        .await?;
    assert_eq!(echo.id(), echo_again.id());

    let output = sandbox
        .command(echo)
        .input("this is deliberately longer than five bytes")
        .output_bytes(5)
        .output()
        .await?;

    assert_eq!(output.stdout.bytes(), b"this ");
    assert!(output.stdout.truncated());

    let bare = sandbox.command("echo").input("ok").output().await?;
    assert_eq!(bare.stdout.bytes(), b"ok");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn command_environment_overrides_the_sandbox_environment() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_echo_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client
        .sandboxes()
        .create()
        .package(PackageSource::path(fixture.path()))
        .env("SDK_SCOPE", "sandbox")
        .await?;

    let output = sandbox
        .command("env")
        .env("SDK_SCOPE", "command")
        .output()
        .await?;
    let environment: Vec<_> = output
        .stdout
        .bytes()
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();

    assert!(environment.contains(&b"SDK_SCOPE=command".as_slice()));
    assert!(!environment.contains(&b"SDK_SCOPE=sandbox".as_slice()));
    Ok(())
}

fn write_echo_package(directory: &Path) {
    let manifest = r#"
[package]
name = "local/echo"
version = "0.1.0"
description = "Local stdin/stdout test package"
entrypoint = "echo"

[[module]]
name = "echo"
source = "echo.wasm"
abi = "wasi"

[[command]]
name = "echo"
module = "echo"

[[module]]
name = "env"
source = "env.wasm"
abi = "wasi"

[[command]]
name = "env"
module = "env"
"#;
    std::fs::write(directory.join("wasmer.toml"), manifest).expect("write manifest");
    std::fs::write(
        directory.join("echo.wasm"),
        wat::parse_str(ECHO_WAT).expect("compile WAT"),
    )
    .expect("write Wasm module");
    std::fs::write(
        directory.join("env.wasm"),
        wat::parse_str(ENV_WAT).expect("compile environment WAT"),
    )
    .expect("write environment Wasm module");
}
