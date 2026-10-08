//! A GUI guest of a sandbox, in a window on the desktop.
//!
//! A window system's loop wants the main thread, which the test harness
//! keeps for itself, so this file has a `main` of its own. It opens a window
//! on the screen, so it only runs when `WGUI_TEST_WINDOWS` is set; the window
//! opens behind whatever is in front.
//!
//! The guest is a test program of `packages/gui`; build it with
//! `make -C packages/gui programs` (needs `wasixcc`). What it prints here
//! must be what it prints on the headless window system.

use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use tempfile::TempDir;
use wasmer_sdk::gui::native::{GuiExit, NativeOptions};
use wasmer_sdk::gui::{GuiCtx, run_main_with};
use wasmer_sdk::{CacheConfig, Wasmer, WasmerConfig};

fn main() -> ExitCode {
    if std::env::var_os("WGUI_TEST_WINDOWS").is_none() {
        println!("skipped: set WGUI_TEST_WINDOWS=1 to open a real window");
        return ExitCode::SUCCESS;
    }
    let gui_tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/gui/tests");
    let program = gui_tests.join("programs/out/window_smoke.wasm");
    let Ok(wasm) = std::fs::read(&program) else {
        println!("skipped: {} is not built", program.display());
        return ExitCode::SUCCESS;
    };
    let expected = std::fs::read_to_string(gui_tests.join("expected/window_smoke.txt"))
        .expect("the expected output");

    let options = NativeOptions {
        activate: false,
        ..NativeOptions::default()
    };
    let ran = run_main_with(options, move |windows| async move {
        let dir = TempDir::new()?;
        let client = Wasmer::with_config(WasmerConfig {
            cache: CacheConfig {
                root: dir.path().to_owned(),
            },
            ..WasmerConfig::default()
        })?;
        let gui = GuiCtx::builder().window_system(Arc::new(windows)).build();
        let sandbox = client
            .sandboxes()
            .create()
            .package(wasm)
            .gui(gui.clone())
            .await?;
        let printed = sandbox.command("main").run().await?.text()?;
        sandbox.close().await?;
        client.shutdown().await?;
        Ok::<_, wasmer_sdk::Error>((printed, gui.usage().windows))
    });
    match ran {
        Ok(GuiExit::Finished(Ok((printed, windows_left)))) => {
            if printed == expected && windows_left == 0 {
                println!("ok      window_smoke in a sandbox");
                ExitCode::SUCCESS
            } else {
                println!(
                    "FAILED  window_smoke in a sandbox: {windows_left} windows left\n\
                     --- printed\n{printed}--- instead of\n{expected}"
                );
                ExitCode::FAILURE
            }
        }
        Ok(GuiExit::Finished(Err(error))) => {
            println!("FAILED  window_smoke in a sandbox: {error}");
            ExitCode::FAILURE
        }
        Ok(GuiExit::Closed) => {
            println!("FAILED  the window system ended the run");
            ExitCode::FAILURE
        }
        Err(error) => {
            println!("FAILED  the window system did not start: {error}");
            ExitCode::FAILURE
        }
    }
}
