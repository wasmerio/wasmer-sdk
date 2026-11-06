#![cfg(feature = "sys")]
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, PackageSource, Result, Wasmer, WasmerConfig};

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_headless_client_preloads_then_runs_concurrent_commands() -> Result<()> {
    let cache = TempDir::new()?;
    let config = || WasmerConfig {
        cache: CacheConfig {
            root: cache.path().to_owned(),
        },
        ..WasmerConfig::default()
    };
    let engine = wasmer::Engine::default();
    let bytes =
        wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
            .unwrap();
    let sha256: [u8; 32] = Sha256::digest(&bytes).into();
    let compiler = Wasmer::with_engine(config(), engine.clone())?;
    compiler.packages().precompile(bytes).await?;
    compiler.shutdown().await?;
    let headless = wasmer::sys::engine::Engine::headless_with_identity(
        &engine.deterministic_id(),
        &engine.artifact_format(),
    )
    .into();
    let client = Wasmer::with_engine(config(), headless)?;
    assert!(client.preload_module(sha256).await.unwrap());
    assert!(!client.preload_module([99; 32]).await.unwrap());
    let package = client
        .packages()
        .load(PackageSource::precompiled_module(sha256))
        .await?;
    let mut sandboxes = Vec::new();
    for _ in 0..8 {
        sandboxes.push(client.sandboxes().create().package(package.clone()).await?);
    }
    for output in futures::future::join_all(
        sandboxes
            .iter()
            .map(|sandbox| async move { sandbox.command("main").run().await }),
    )
    .await
    {
        assert_eq!(output?.status.code(), 0);
    }
    for sandbox in sandboxes {
        sandbox.close().await?;
    }
    client.shutdown().await?;
    assert!(!client.preload_module(sha256).await.unwrap());
    Ok(())
}
