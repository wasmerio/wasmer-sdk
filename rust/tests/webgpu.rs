//! A guest built against `webgpu.h` runs in a sandbox that was granted the
//! GPU, and only there.
//!
//! The guest is one of the conformance programs of `packages/webgpu`; build
//! them with `packages/webgpu/tests/build-test-wasix.sh` (needs `wasixcc`).

#![cfg(feature = "webgpu")]

use std::path::Path;

use bytes::Bytes;
use tempfile::TempDir;
use wasmer_sdk::webgpu::WebGpuCtx;
use wasmer_sdk::{CacheConfig, Result, Wasmer, WasmerConfig};

fn client() -> (Wasmer, TempDir) {
    let dir = TempDir::new().unwrap();
    let client = Wasmer::with_config(WasmerConfig {
        cache: CacheConfig {
            root: dir.path().to_owned(),
        },
        ..WasmerConfig::default()
    })
    .unwrap();
    (client, dir)
}

fn guest() -> Option<Bytes> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/webgpu/tests/programs/out/compute_double.wasm");
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes.into()),
        Err(_) => {
            eprintln!("skipping: {} is not built", path.display());
            None
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_webgpu_guest_computes_in_a_sandbox_with_the_gpu() -> Result<()> {
    let Some(wasm) = guest() else { return Ok(()) };
    let (client, _dir) = client();
    let webgpu = WebGpuCtx::default();
    let sandbox = client
        .sandboxes()
        .create()
        .package(wasm)
        .webgpu(webgpu.clone())
        .await?;
    let output = sandbox.command("main").run().await?;
    assert_eq!(
        output.text()?,
        "1 21 41 61 81 101 121 141 161 181 201 221 241 261 281 301\nok\n"
    );
    // The guest released everything it created before it exited.
    assert_eq!(webgpu.usage().devices, 0);
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_grant_the_guest_cannot_start() -> Result<()> {
    let Some(wasm) = guest() else { return Ok(()) };
    let (client, _dir) = client();
    let sandbox = client.sandboxes().create().package(wasm).await?;
    // The WebGPU imports are simply not there, so instantiation fails.
    assert!(sandbox.command("main").run().await.is_err());
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}
