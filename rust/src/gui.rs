//! Windows and input for sandboxed guests.
//!
//! Hand a [`GuiCtx`] to [`SandboxBuilder::gui`](crate::SandboxBuilder::gui) to
//! let a sandbox's commands open windows. Without a window system of its own
//! a `GuiCtx` is headless: its windows work, and nobody sees them. With the
//! `gui-window` feature, `run_main` gives it the desktop's; in a browser
//! (`js-gui`), `web::open` gives it the canvases of the page.
//!
//! Everything here is the [`wasmer_gui`] crate, but for `run_main`.

pub use wasmer_gui::*;

/// Runs `main` to its end while the calling thread serves the desktop's
/// windows.
///
/// A window system's event loop wants the process's main thread, and an
/// embedder's own work is asynchronous. So this is what `fn main` calls, and
/// `main` runs on a Tokio runtime of its own on another thread. It is handed
/// the window system, from which it makes the context its sandboxes get:
///
/// ```no_run
/// use std::sync::Arc;
/// use wasmer_sdk::gui::GuiCtx;
///
/// fn main() -> wasmer_sdk::Result<()> {
///     wasmer_sdk::gui::run_main(|windows| async move {
///         let gui = GuiCtx::builder()
///             .window_system(Arc::new(windows))
///             .build();
///         let wasmer = wasmer_sdk::Wasmer::new()?;
///         let sandbox = wasmer
///             .sandboxes()
///             .create()
///             .package("my/app")
///             .gui(gui)
///             .await?;
///         sandbox.command("app").run().await?;
///         Ok(())
///     })?
/// }
/// ```
///
/// Nothing touches the display until a guest opens a window, so a program
/// whose guests never do runs without one. A user closing a window is a
/// request the guest answers; ending a guest that does not is the caller's
/// business (a timeout, [`Process::kill`](crate::Process)), or the window
/// system's with [`run_main_with`].
///
/// # Errors
///
/// When the Tokio runtime or the window system's loop cannot be started, or
/// `main` panics.
#[cfg(feature = "gui-window")]
pub fn run_main<F>(
    main: impl FnOnce(native::WinitSystem) -> F + Send + 'static,
) -> crate::Result<F::Output>
where
    F: Future,
    F::Output: Send + 'static,
{
    match run_main_with(native::NativeOptions::default(), main)? {
        native::GuiExit::Finished(output) => Ok(output),
        // Only a window system told to end stuck guests does this, and this
        // one was not.
        native::GuiExit::Closed => Err(crate::Error::Initialization {
            message: "the window system ended the run".to_owned(),
        }),
    }
}

/// [`run_main`] with a say in how the window system behaves: whether new
/// windows take the keyboard, and what happens to a guest that does not
/// answer its window being closed.
///
/// With [`CloseBehavior::RequestThenEnd`](native::CloseBehavior), a user who
/// closes the window of a stuck guest ends the run: this returns
/// [`GuiExit::Closed`](native::GuiExit) while `main` is still running on its
/// thread, for the caller to exit the process.
///
/// # Errors
///
/// When the Tokio runtime or the window system's loop cannot be started, or
/// `main` panics.
#[cfg(feature = "gui-window")]
pub fn run_main_with<F>(
    options: native::NativeOptions,
    main: impl FnOnce(native::WinitSystem) -> F + Send + 'static,
) -> crate::Result<native::GuiExit<F::Output>>
where
    F: Future,
    F::Output: Send + 'static,
{
    let failed = |message: String| crate::Error::Initialization { message };
    let (main_thread, windows) = native::GuiMainThread::with_options(options);
    let exit = main_thread
        .run(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            Ok::<_, std::io::Error>(runtime.block_on(main(windows)))
        })
        .map_err(|error| failed(format!("{error:#}")))?;
    match exit {
        native::GuiExit::Finished(output) => output
            .map(native::GuiExit::Finished)
            .map_err(|error| failed(format!("no Tokio runtime: {error}"))),
        native::GuiExit::Closed => Ok(native::GuiExit::Closed),
    }
}
