use std::{path::Path, sync::Arc};

use tempfile::TempDir;
use wasmer_sdk::{
    CacheConfig, Directory, Error, FileSystem, MountMode, PackageSource, Result, Wasmer,
    WasmerConfig,
};

const MOUNT_COPY_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_prestat_get"
    (func $fd_prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name"
    (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 200) "external/input.txt")
  (data (i32.const 240) "external/output.txt")
  (func (export "_start")
    (local $fd i32)
    (local $dirfd i32)
    (local $input i32)
    (local $output i32)
    (local $count i32)
    (local.set $fd (i32.const 3))
    (local.set $dirfd (i32.const -1))
    (block $found
      (loop $search
        (if
          (i32.eqz
            (call $fd_prestat_get (local.get $fd) (i32.const 0)))
          (then
            (drop
              (call $fd_prestat_dir_name
                (local.get $fd)
                (i32.const 100)
                (i32.load (i32.const 4))))
            (if
              (i32.and
                (i32.eq (i32.load (i32.const 4)) (i32.const 1))
                (i32.eq
                  (i32.load8_u (i32.const 100))
                  (i32.const 47)))
              (then
                (local.set $dirfd (local.get $fd))
                (br $found)))))
        (local.set $fd (i32.add (local.get $fd) (i32.const 1)))
        (br_if $search (i32.lt_u (local.get $fd) (i32.const 32)))))
    (if (i32.eq (local.get $dirfd) (i32.const -1))
      (then (call $proc_exit (i32.const 91))))
    (if
      (call $path_open
        (local.get $dirfd)
        (i32.const 0)
        (i32.const 200)
        (i32.const 18)
        (i32.const 0)
        (i64.const 2)
        (i64.const 0)
        (i32.const 0)
        (i32.const 16))
      (then (call $proc_exit (i32.const 92))))
    (local.set $input (i32.load (i32.const 16)))
    (i32.store (i32.const 20) (i32.const 400))
    (i32.store (i32.const 24) (i32.const 4096))
    (if
      (call $fd_read
        (local.get $input)
        (i32.const 20)
        (i32.const 1)
        (i32.const 8))
      (then (call $proc_exit (i32.const 93))))
    (local.set $count (i32.load (i32.const 8)))
    (drop (call $fd_close (local.get $input)))
    (if
      (call $path_open
        (local.get $dirfd)
        (i32.const 0)
        (i32.const 240)
        (i32.const 19)
        (i32.const 9)
        (i64.const 64)
        (i64.const 0)
        (i32.const 0)
        (i32.const 16))
      (then (call $proc_exit (i32.const 94))))
    (local.set $output (i32.load (i32.const 16)))
    (i32.store (i32.const 24) (local.get $count))
    (if
      (call $fd_write
        (local.get $output)
        (i32.const 20)
        (i32.const 1)
        (i32.const 12))
      (then (call $proc_exit (i32.const 95))))
    (drop (call $fd_close (local.get $output)))))
"#;

#[tokio::test(flavor = "multi_thread")]
async fn guest_reads_and_writes_an_external_provider_mount() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::with_config(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let external = Directory::new();
    external.write_text("input.txt", "from provider").await?;
    let provider: Arc<dyn FileSystem> = Arc::new(external.clone());
    let sandbox = client
        .sandboxes()
        .create()
        .package(PackageSource::path(fixture.path()))
        .mount("/external", provider, MountMode::ReadWrite)
        .await?;

    sandbox.command("copy-mount").run().await?;
    assert_eq!(external.read_text("output.txt").await?, "from provider");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_mount_rejects_guest_writes() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::with_config(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let external = Directory::new();
    external.write_text("input.txt", "readable").await?;
    let provider: Arc<dyn FileSystem> = Arc::new(external.clone());
    let sandbox = client
        .sandboxes()
        .create()
        .package(PackageSource::path(fixture.path()))
        .mount("/external", provider, MountMode::ReadOnly)
        .await?;

    let error = sandbox.command("copy-mount").run().await.unwrap_err();
    let Error::ProcessExit(error) = error else {
        panic!("expected a process exit error");
    };
    assert_eq!(error.output().status.code(), 94);
    assert!(external.read_text("output.txt").await.is_err());
    Ok(())
}

fn write_package(directory: &Path) {
    let manifest = r#"
[package]
name = "local/mount-copy"
version = "0.1.0"
description = "External mount test package"
entrypoint = "copy-mount"

[[module]]
name = "copy-mount"
source = "copy-mount.wasm"
abi = "wasi"

[[command]]
name = "copy-mount"
module = "copy-mount"
"#;
    std::fs::write(directory.join("wasmer.toml"), manifest).expect("write manifest");
    std::fs::write(
        directory.join("copy-mount.wasm"),
        wat::parse_str(MOUNT_COPY_WAT).expect("compile WAT"),
    )
    .expect("write Wasm module");
}
