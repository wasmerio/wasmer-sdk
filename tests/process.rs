use std::{path::Path, time::Duration};

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::{CacheConfig, ExitReason, PackageSource, Result, Stdio, Wasmer, WasmerConfig};

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

#[tokio::test(flavor = "multi_thread")]
async fn spawned_process_streams_stdin_stdout_and_retains_diagnostics() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = client(&state)?;
    let sandbox = client
        .sandbox()
        .package(PackageSource::path(fixture.path()))
        .start()
        .await?;

    let mut process = sandbox
        .command("echo")
        .stdin(Stdio::Piped)
        .output_bytes(5)
        .stream_bytes(16)
        .spawn()
        .await?;
    assert!(process.id() > 0);

    let mut stdin = process.take_stdin().expect("piped stdin");
    let mut stdout = process.take_stdout().expect("piped stdout");
    let mut stderr = process.take_stderr().expect("piped stderr");
    stdin.write_all(b"streamed input").await?;
    stdin.close().await?;

    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });

    let output = process.wait().await?;
    assert_eq!(stdout_task.await.expect("stdout task")?, b"streamed input");
    assert!(stderr_task.await.expect("stderr task")?.is_empty());
    assert_eq!(output.stdout.bytes(), b"strea");
    assert!(output.stdout.truncated());
    assert_eq!(process.wait().await?, output);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn terminate_stops_a_process_blocked_on_live_stdin() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = client(&state)?;
    let sandbox = client
        .sandbox()
        .package(PackageSource::path(fixture.path()))
        .start()
        .await?;
    let mut process = sandbox
        .command("echo")
        .stdin(Stdio::Piped)
        .stdout(Stdio::Null)
        .stderr(Stdio::Null)
        .spawn()
        .await?;

    tokio::time::timeout(
        Duration::from_secs(3),
        process.terminate(Duration::from_millis(50)),
    )
    .await
    .expect("termination timed out")?;
    assert!(process.try_wait()?.is_some());
    assert!(!process.wait().await?.status.success());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_sandbox_kills_its_live_processes() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = client(&state)?;
    let sandbox = client
        .sandbox()
        .package(PackageSource::path(fixture.path()))
        .start()
        .await?;
    let mut process = sandbox
        .command("echo")
        .stdin(Stdio::Piped)
        .stdout(Stdio::Null)
        .stderr(Stdio::Null)
        .spawn()
        .await?;

    sandbox.close().await?;
    tokio::time::timeout(Duration::from_secs(3), process.wait())
        .await
        .expect("sandbox cleanup timed out")?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_sandbox_preserves_a_natural_unwaited_exit() -> Result<()> {
    let fixture = TempDir::new().expect("create fixture directory");
    write_package(fixture.path());
    let state = TempDir::new().expect("create SDK state directory");
    let client = client(&state)?;
    let sandbox = client
        .sandbox()
        .package(PackageSource::path(fixture.path()))
        .start()
        .await?;
    let mut process = sandbox
        .command("echo")
        .stdin(Stdio::Null)
        .stdout(Stdio::Piped)
        .stderr(Stdio::Null)
        .spawn()
        .await?;

    let mut stdout = process.take_stdout().expect("piped stdout");
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), stdout.read_to_end(&mut bytes))
        .await
        .expect("guest did not close stdout")?;
    tokio::time::sleep(Duration::from_millis(25)).await;
    sandbox.close().await?;

    let output = process.wait().await?;
    assert_eq!(output.reason, ExitReason::Exited);
    assert_eq!(output.status.code(), 0);
    Ok(())
}

fn client(state: &TempDir) -> Result<Wasmer> {
    Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })
}

fn write_package(directory: &Path) {
    let manifest = r#"
[package]
name = "local/stream-echo"
version = "0.1.0"
description = "Live stream test package"
entrypoint = "echo"

[[module]]
name = "echo"
source = "echo.wasm"
abi = "wasi"

[[command]]
name = "echo"
module = "echo"
"#;
    std::fs::write(directory.join("wasmer.toml"), manifest).expect("write manifest");
    std::fs::write(
        directory.join("echo.wasm"),
        wat::parse_str(ECHO_WAT).expect("compile WAT"),
    )
    .expect("write Wasm module");
}
