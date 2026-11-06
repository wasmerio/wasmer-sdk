#![cfg(feature = "sys")]

use tempfile::TempDir;
use wasmer::sys::NativeEngineExt;
use wasmer_sdk::{CacheConfig, Result, Wasmer, WasmerConfig};

const PROGRAM: &str = r#"(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start") (call $exit (i32.const 0))))"#;

fn config(root: &TempDir) -> WasmerConfig {
    WasmerConfig {
        cache: CacheConfig {
            root: root.path().to_owned(),
        },
        ..WasmerConfig::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_injected_compiler_executes_commands() -> Result<()> {
    let cache = TempDir::new()?;
    let client = Wasmer::with_engine(config(&cache), wasmer::Engine::default())?;
    let sandbox = client
        .sandboxes()
        .create()
        .package(wat::parse_str(PROGRAM).unwrap())
        .await?;
    assert_eq!(sandbox.command("main").run().await?.status.code(), 0);
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_headless_engine_cannot_reuse_a_different_engines_compiled_cache() -> Result<()> {
    let cache = TempDir::new()?;
    let bytes = wat::parse_str(PROGRAM).unwrap();
    let compiler = Wasmer::with_engine(config(&cache), wasmer::Engine::default())?;
    let sandbox = compiler.sandboxes().create().package(bytes.clone()).await?;
    assert_eq!(sandbox.command("main").run().await?.status.code(), 0);
    sandbox.close().await?;
    compiler.shutdown().await?;

    // Selecting the caller's headless engine must remain observable even
    // when a compiler has already populated the same cache root.
    let runtime = Wasmer::with_engine(config(&cache), wasmer::Engine::headless())?;
    let sandbox = runtime.sandboxes().create().package(bytes).await?;
    let error = sandbox.command("main").run().await.unwrap_err();
    assert!(error.to_string().contains("No compiler"), "{error}");
    sandbox.close().await?;
    runtime.shutdown().await?;
    Ok(())
}
