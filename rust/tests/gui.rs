//! A guest built against `<wasmer/gui.h>` runs in a sandbox that was given a
//! GUI, and only there; and a command of such a sandbox can always be
//! stopped, also where it waits for input.
//!
//! The guests are test programs of `packages/gui`; build them with
//! `make -C packages/gui programs` (needs `wasixcc`).

#![cfg(all(feature = "gui", not(target_arch = "wasm32")))]

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use tempfile::TempDir;
use wasmer_sdk::gui::GuiCtx;
use wasmer_sdk::gui::headless::HeadlessSystem;
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

fn guest(name: &str) -> Option<Bytes> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/gui/tests/programs/out")
        .join(format!("{name}.wasm"));
    if let Ok(bytes) = std::fs::read(&path) {
        Some(bytes.into())
    } else {
        eprintln!("skipping: {} is not built", path.display());
        None
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gui_guest_runs_in_a_sandbox_with_a_gui() -> Result<()> {
    let Some(wasm) = guest("threads") else {
        return Ok(());
    };
    let (client, _dir) = client();
    let gui = GuiCtx::default();
    let sandbox = client
        .sandboxes()
        .create()
        .package(wasm)
        .gui(gui.clone())
        .await?;
    let output = sandbox.command("main").run().await?;
    assert_eq!(
        output.text()?,
        "resized to 320x240 by the other thread\nwoken by the other thread\n\
         a wake waits for the next wait\ndone\n"
    );
    // Nothing of the guest is left.
    assert_eq!(gui.usage().windows, 0);
    assert_eq!(gui.usage().instances, 0);
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_gui_the_guest_cannot_start() -> Result<()> {
    let Some(wasm) = guest("threads") else {
        return Ok(());
    };
    let (client, _dir) = client();
    let sandbox = client.sandboxes().create().package(wasm).await?;
    // The GUI imports are simply not there, so instantiation fails.
    assert!(sandbox.command("main").run().await.is_err());
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_waiting_for_input_can_be_killed() -> Result<()> {
    let Some(wasm) = guest("events") else {
        return Ok(());
    };
    let (client, _dir) = client();
    let system = HeadlessSystem::default();
    let gui = GuiCtx::builder()
        .window_system(Arc::new(system.clone()))
        .build();
    let sandbox = client
        .sandboxes()
        .create()
        .package(wasm)
        .gui(gui.clone())
        .await?;

    // Two commands of one sandbox are apart: each has its own windows.
    let mut first = sandbox.command("main").spawn().await?;
    let mut second = sandbox.command("main").spawn().await?;
    let waited = Instant::now();
    while !(system.windows().len() == 2 && system.is_idle()) {
        assert!(
            waited.elapsed() < Duration::from_secs(30),
            "the guests did not start"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let killed = Instant::now();
    first.kill()?;
    let output = tokio::time::timeout(Duration::from_secs(5), first.wait())
        .await
        .expect("a killed command ends")?;
    assert!(!output.status.success());
    assert!(
        killed.elapsed() < Duration::from_secs(2),
        "{:?}",
        killed.elapsed()
    );
    // Its window went with it; the other command's is untouched.
    assert_eq!(system.windows().len(), 1);
    assert_eq!(gui.usage().windows, 1);

    // The user closes the other one's window: it ends by itself.
    system.windows()[0].close();
    let output = tokio::time::timeout(Duration::from_secs(5), second.wait())
        .await
        .expect("the command ends")?;
    assert!(output.status.success());
    assert!(output.text()?.ends_with("done\n"));
    assert_eq!(gui.usage().windows, 0);

    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}
