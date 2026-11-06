#![cfg(feature = "sys")]

use sha2::{Digest, Sha256};
use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, PackageSource, Result, Wasmer, WasmerConfig};

fn config(cache: &TempDir) -> WasmerConfig {
    WasmerConfig {
        cache: CacheConfig {
            root: cache.path().to_owned(),
        },
        ..WasmerConfig::default()
    }
}

fn runtime_engine(compiler: &wasmer::Engine) -> wasmer::Engine {
    wasmer::sys::engine::Engine::headless_with_identity(
        &compiler.deterministic_id(),
        &compiler.artifact_format(),
    )
    .into()
}

#[tokio::test(flavor = "multi_thread")]
async fn precompile_never_executes_guest_code_and_headless_clients_reuse_the_cache() -> Result<()> {
    let cache = TempDir::new()?;
    let engine = wasmer::Engine::default();
    let compiler = Wasmer::with_engine(config(&cache), engine.clone())?;
    let traps = wat::parse_str(
        "(module (memory (export \"memory\") 1) (func (export \"_start\") unreachable))",
    )
    .unwrap();
    compiler.packages().precompile(traps).await?;
    let bytes =
        wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
            .unwrap();
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let raw = compiler.packages().load(bytes.clone()).await?;
    compiler.packages().precompile(bytes).await?;
    compiler.shutdown().await?;

    let runtime = Wasmer::with_engine(config(&cache), runtime_engine(&engine))?;
    let package = runtime
        .packages()
        .load(PackageSource::precompiled_module(digest))
        .await?;
    assert_eq!(package.id(), raw.id());
    runtime.packages().precompile(package.clone()).await?;
    let sandbox = runtime.sandboxes().create().package(package).await?;
    assert_eq!(sandbox.command("main").run().await?.status.code(), 0);
    sandbox.close().await?;
    runtime.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_precompiled_modules_have_a_distinct_error_even_with_a_compiler() -> Result<()> {
    let cache = TempDir::new()?;
    let compiler = wasmer::Engine::default();
    for engine in [compiler.clone(), runtime_engine(&compiler)] {
        let client = Wasmer::with_engine(config(&cache), engine)?;
        let package = client
            .packages()
            .load(PackageSource::precompiled_module([7; 32]))
            .await?;
        let error = client
            .packages()
            .precompile(package.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "MODULE_NOT_COMPILED");
        let sandbox = client.sandboxes().create().package(package).await?;
        let error = sandbox.command("main").run().await.unwrap_err();
        assert_eq!(error.code(), "MODULE_NOT_COMPILED");
        assert!(error.to_string().contains(&"07".repeat(32)));
        sandbox.close().await?;
        client.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_artifact_does_not_fall_back_to_compiling_empty_bytes() -> Result<()> {
    fn artifact(dir: &std::path::Path) -> std::path::PathBuf {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                return artifact(&path);
            }
            if path.extension().is_some_and(|extension| extension == "bin") {
                return path;
            }
        }
        panic!("missing compiled artifact in {}", dir.display());
    }
    let cache = TempDir::new()?;
    let engine = wasmer::Engine::default();
    let bytes =
        wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"_start\")))")
            .unwrap();
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let compiler = Wasmer::with_engine(config(&cache), engine.clone())?;
    compiler.packages().precompile(bytes).await?;
    compiler.shutdown().await?;
    std::fs::write(
        artifact(&cache.path().join("cache-v1/compiled")),
        b"invalid artifact",
    )?;
    let runtime = Wasmer::with_engine(config(&cache), runtime_engine(&engine))?;
    let sandbox = runtime
        .sandboxes()
        .create()
        .package(PackageSource::precompiled_module(digest))
        .await?;
    assert_eq!(
        sandbox.command("main").run().await.unwrap_err().code(),
        "MODULE_NOT_COMPILED"
    );
    sandbox.close().await?;
    runtime.shutdown().await?;
    Ok(())
}
