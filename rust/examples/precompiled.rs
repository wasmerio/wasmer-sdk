//! Compile with the default features, then execute with only `sys-runtime`:
//! cargo run -p wasmer-sdk --example precompiled -- compile /tmp/sdk-cache
//! cargo run -p wasmer-sdk --example precompiled --no-default-features --features sys-runtime -- run /tmp/sdk-cache
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use wasmer_sdk::{CacheConfig, PackageSource, Wasmer, WasmerConfig};

#[derive(Serialize, Deserialize)]
struct Artifact {
    sha256: [u8; 32],
    engine: String,
    format: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let operation = args.next().ok_or("expected compile or run")?;
    let root = PathBuf::from(args.next().ok_or("expected a cache directory")?);
    let manifest = root.join("precompiled.json");
    let config = WasmerConfig {
        cache: CacheConfig { root },
        ..WasmerConfig::default()
    };
    match operation.as_str() {
        #[cfg(feature = "sys")]
        "compile" => {
            use sha2::{Digest, Sha256};
            let bytes = wat::parse_str(
                "(module (memory (export \"memory\") 1) (func (export \"_start\")))",
            )?;
            let engine = wasmer::Engine::default();
            let artifact = Artifact {
                sha256: Sha256::digest(&bytes).into(),
                engine: engine.deterministic_id(),
                format: engine.artifact_format(),
            };
            let client = Wasmer::with_engine(config, engine)?;
            client.packages().precompile(bytes).await?;
            std::fs::write(manifest, serde_json::to_vec(&artifact)?)?;
            client.shutdown().await?;
        }
        "run" => {
            let artifact: Artifact = serde_json::from_slice(&std::fs::read(manifest)?)?;
            let engine = wasmer::sys::engine::Engine::headless_with_identity(
                &artifact.engine,
                &artifact.format,
            )
            .into();
            let client = Wasmer::with_engine(config, engine)?;
            let sandbox = client
                .sandboxes()
                .create()
                .package(PackageSource::precompiled_module(artifact.sha256))
                .await?;
            assert_eq!(sandbox.command("main").run().await?.status.code(), 0);
            sandbox.close().await?;
            client.shutdown().await?;
            println!("precompiled module executed without a compiler");
        }
        _ => return Err("expected compile (requires sys) or run".into()),
    }
    Ok(())
}
