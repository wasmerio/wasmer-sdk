use std::path::Path;

use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, PackageSource, Result, Stdio, Wasmer, WasmerConfig};

const COPY_ON_WRITE_ROOT_WAT: &str = r#"
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
  (data (i32.const 200) "data/input.txt")
  (data (i32.const 240) "payload.txt")
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
          (i32.eqz (call $fd_prestat_get (local.get $fd) (i32.const 0)))
          (then
            (drop
              (call $fd_prestat_dir_name
                (local.get $fd)
                (i32.const 100)
                (i32.load (i32.const 4))))
            (if
              (i32.and
                (i32.eq (i32.load (i32.const 4)) (i32.const 1))
                (i32.eq (i32.load8_u (i32.const 100)) (i32.const 47)))
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
        (i32.const 14)
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
        (i32.const 11)
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
async fn local_package_root_is_copy_on_write_and_child_mounts_are_visible() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client
        .sandbox()
        .package(PackageSource::path(fixture.path()))
        .start()
        .await?;

    let mut process = sandbox
        .command("copy")
        .stdout(Stdio::Null)
        .stderr(Stdio::Null)
        .spawn()
        .await?;
    process.wait().await?.check()?;

    assert_eq!(
        std::fs::read_to_string(fixture.path().join("root/payload.txt"))
            .expect("read host payload"),
        "host payload"
    );
    Ok(())
}

fn write_package(directory: &Path) {
    std::fs::create_dir_all(directory.join("root")).expect("create root directory");
    std::fs::create_dir_all(directory.join("data")).expect("create data directory");
    std::fs::write(directory.join("root/payload.txt"), "host payload").expect("write payload");
    std::fs::write(directory.join("data/input.txt"), "guest copy").expect("write input");
    std::fs::write(
        directory.join("wasmer.toml"),
        r#"
[package]
name = "local/copy-on-write-root"
version = "0.1.0"
description = "Local package root mount regression test"
entrypoint = "copy"

[fs]
"/" = "root"
"/data" = "data"

[[module]]
name = "copy"
source = "copy.wasm"
abi = "wasi"

[[command]]
name = "copy"
module = "copy"
"#,
    )
    .expect("write manifest");
    std::fs::write(
        directory.join("copy.wasm"),
        wat::parse_str(COPY_ON_WRITE_ROOT_WAT).expect("compile WAT"),
    )
    .expect("write Wasm module");
}
