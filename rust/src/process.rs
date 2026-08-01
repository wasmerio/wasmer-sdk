use std::{
    fmt, io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use futures::future::Either;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasmer_wasix::{
    os::task::{TaskJoinHandle, process::WasiProcess},
    os::tty::{InputEvent, Tty},
    runtime::task_manager::VirtualTaskManager,
};
#[cfg(target_arch = "wasm32")]
use wasmer_wasix_types::wasi::ExitCode;
use wasmer_wasix_types::wasi::Signal;

use crate::{
    CapturedOutput, Error, ExitReason, ExitStatus, Output, Result,
    capture::CaptureHandle,
    stream::{PipeCloser, PipeReader, PipeWriter},
    terminal::TerminalBridge,
};

/// Writable live stdin for a spawned guest process.
pub struct ProcessStdin {
    inner: Option<ProcessStdinInner>,
    closer: PipeCloser,
}

enum ProcessStdinInner {
    Pipe(PipeWriter),
    Terminal(Box<TerminalStdin>),
}

struct TerminalStdin {
    tty: Option<Tty>,
    pending: Option<futures::future::BoxFuture<'static, Tty>>,
    pending_len: usize,
}

impl fmt::Debug for ProcessStdin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessStdin")
            .field("open", &self.inner.is_some())
            .finish_non_exhaustive()
    }
}

impl ProcessStdin {
    pub(crate) fn new(inner: PipeWriter, closer: PipeCloser) -> Self {
        Self {
            inner: Some(ProcessStdinInner::Pipe(inner)),
            closer,
        }
    }

    pub(crate) fn terminal(tty: Tty, closer: PipeCloser) -> Self {
        Self {
            inner: Some(ProcessStdinInner::Terminal(Box::new(TerminalStdin {
                tty: Some(tty),
                pending: None,
                pending_len: 0,
            }))),
            closer,
        }
    }

    pub(crate) fn closer(&self) -> PipeCloser {
        self.closer.clone()
    }

    /// Close the stream and deliver EOF to the guest.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the stream cannot be shut down.
    pub async fn close(&mut self) -> io::Result<()> {
        tokio::io::AsyncWriteExt::shutdown(self).await
    }
}

impl AsyncWrite for ProcessStdin {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(stream) = this.inner.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        match stream {
            ProcessStdinInner::Pipe(stream) => Pin::new(stream).poll_write(cx, bytes),
            ProcessStdinInner::Terminal(terminal) => {
                let TerminalStdin {
                    tty,
                    pending,
                    pending_len,
                } = terminal.as_mut();
                if pending.is_none() {
                    let Some(current) = tty.take() else {
                        return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
                    };
                    *pending_len = bytes.len();
                    *pending = Some(current.on_event(InputEvent::Raw(bytes.to_vec())));
                }
                let future = pending.as_mut().expect("terminal write future");
                match future.as_mut().poll(cx) {
                    Poll::Ready(next) => {
                        let written = *pending_len;
                        *tty = Some(next);
                        *pending = None;
                        *pending_len = 0;
                        Poll::Ready(Ok(written))
                    }
                    Poll::Pending => Poll::Pending,
                }
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(stream) = this.inner.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        match stream {
            ProcessStdinInner::Pipe(stream) => Pin::new(stream).poll_flush(cx),
            ProcessStdinInner::Terminal(_) => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(stream) = this.inner.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match stream {
            ProcessStdinInner::Pipe(stream) => match Pin::new(stream).poll_shutdown(cx) {
                Poll::Ready(result) => {
                    this.inner.take();
                    Poll::Ready(result)
                }
                Poll::Pending => Poll::Pending,
            },
            ProcessStdinInner::Terminal(_) => {
                this.inner.take();
                Poll::Ready(Ok(()))
            }
        }
    }
}

macro_rules! process_output_stream {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Debug)]
        pub struct $name {
            inner: PipeReader,
        }

        impl $name {
            pub(crate) fn new(inner: PipeReader) -> Self {
                Self { inner }
            }
        }

        impl AsyncRead for $name {
            fn poll_read(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buffer: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                Pin::new(&mut self.inner).poll_read(cx, buffer)
            }
        }
    };
}

process_output_stream!(
    ProcessStdout,
    "Readable live stdout from a spawned guest process."
);
process_output_stream!(
    ProcessStderr,
    "Readable live stderr from a spawned guest process."
);

/// A running guest process with single-owner live streams.
#[derive(Debug)]
pub struct Process {
    id: u32,
    control: Arc<ProcessControl>,
    tasks: Arc<dyn VirtualTaskManager>,
    task: TaskJoinHandle,
    stdin: Option<ProcessStdin>,
    stdout: Option<ProcessStdout>,
    stderr: Option<ProcessStderr>,
    stdout_capture: CaptureHandle,
    stderr_capture: CaptureHandle,
    terminal: Option<Arc<TerminalBridge>>,
    completed: Option<Output>,
}

impl Process {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        process: WasiProcess,
        tasks: Arc<dyn VirtualTaskManager>,
        task: TaskJoinHandle,
        stdin: Option<ProcessStdin>,
        stdout: Option<ProcessStdout>,
        stderr: Option<ProcessStderr>,
        stdout_capture: CaptureHandle,
        stderr_capture: CaptureHandle,
        terminal: Option<Arc<TerminalBridge>>,
    ) -> Self {
        let stdin_control = stdin.as_ref().map(ProcessStdin::closer);
        let control = Arc::new(ProcessControl {
            process,
            stdin: stdin_control,
            exit: AtomicU8::new(EXIT_NONE),
        });
        Self {
            id: control.process.pid().raw(),
            control,
            tasks,
            task,
            stdin,
            stdout,
            stderr,
            stdout_capture,
            stderr_capture,
            terminal,
            completed: None,
        }
    }

    pub(crate) fn control(&self) -> &Arc<ProcessControl> {
        &self.control
    }

    /// WASIX process identifier.
    #[must_use]
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Resize the attached terminal.
    ///
    /// # Errors
    ///
    /// Returns an error when this process was not spawned in terminal mode.
    pub fn resize_terminal(&self, columns: u32, rows: u32) -> Result<()> {
        let terminal = self.terminal.as_ref().ok_or_else(|| Error::Execution {
            message: "the process has no terminal".to_owned(),
        })?;
        terminal.resize(columns, rows);
        Ok(())
    }

    /// A cloneable handle that can signal this process without owning it.
    ///
    /// The handle never contends with [`Self::wait`]: killing or terminating
    /// through it works while another task is waiting on the same process.
    #[must_use]
    pub fn handle(&self) -> ProcessHandle {
        ProcessHandle {
            control: Arc::clone(&self.control),
            tasks: Arc::clone(&self.tasks),
            terminal: self.terminal.clone(),
        }
    }

    /// Take ownership of piped stdin. This succeeds at most once.
    #[must_use]
    pub fn take_stdin(&mut self) -> Option<ProcessStdin> {
        self.stdin.take()
    }

    /// Take ownership of piped stdout. This succeeds at most once.
    #[must_use]
    pub fn take_stdout(&mut self) -> Option<ProcessStdout> {
        self.stdout.take()
    }

    /// Take ownership of piped stderr. This succeeds at most once.
    #[must_use]
    pub fn take_stderr(&mut self) -> Option<ProcessStderr> {
        self.stderr.take()
    }

    /// Wait for process completion. Repeated calls return the same output.
    ///
    /// Applications must concurrently consume any taken stdout and stderr
    /// streams; an unread bounded pipe can intentionally backpressure a guest.
    ///
    /// # Errors
    ///
    /// Returns an error if the WASIX task fails without producing an exit code.
    pub async fn wait(&mut self) -> Result<Output> {
        if let Some(output) = &self.completed {
            return Ok(output.clone());
        }
        let code = self
            .task
            .wait_finished()
            .await
            .map_err(|error| Error::Execution {
                message: error.to_string(),
            })?
            .raw();
        let output = self.snapshot(code);
        self.completed = Some(output.clone());
        Ok(output)
    }

    /// Return completed output without waiting.
    ///
    /// # Errors
    ///
    /// Returns an error if the completed WASIX task failed without an exit
    /// code.
    pub fn try_wait(&mut self) -> Result<Option<Output>> {
        if let Some(output) = &self.completed {
            return Ok(Some(output.clone()));
        }
        let Some(result) = self.control.process.try_join() else {
            return Ok(None);
        };
        let code = result
            .map_err(|error| Error::Execution {
                message: error.to_string(),
            })?
            .raw();
        let output = self.snapshot(code);
        self.completed = Some(output.clone());
        Ok(Some(output))
    }

    /// Request graceful termination and escalate to `SIGKILL` after `grace`.
    ///
    /// The completed output remains available through [`Self::wait`].
    ///
    /// # Errors
    ///
    /// Returns an error if process completion fails.
    pub async fn terminate(&mut self, grace: Duration) -> Result<()> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        self.control.signal_terminate();
        let control = Arc::clone(&self.control);
        let grace_elapsed = self.tasks.sleep_now(grace);
        let wait = Box::pin(self.wait());
        match futures::future::select(wait, grace_elapsed).await {
            Either::Left((result, _)) => {
                result?;
            }
            Either::Right(((), wait)) => {
                control.kill();
                wait.await?;
            }
        }
        Ok(())
    }

    /// Immediately signal the guest with `SIGKILL`.
    ///
    /// # Errors
    ///
    /// This operation is currently infallible; the result reserves room for
    /// target-specific signaling failures.
    pub fn kill(&mut self) -> Result<()> {
        self.control.kill();
        Ok(())
    }

    fn snapshot(&self, code: i32) -> Output {
        let (stdout, stdout_truncated) = self.stdout_capture.snapshot();
        let (stderr, stderr_truncated) = self.stderr_capture.snapshot();
        let (reason, status) = self.control.exit_state(code);
        Output {
            status,
            reason,
            stdout: CapturedOutput::from_parts(stdout, stdout_truncated),
            stderr: CapturedOutput::from_parts(stderr, stderr_truncated),
        }
    }
}

/// A cloneable signaling handle for one guest process.
///
/// Unlike [`Process`], the handle does not own streams or completed output;
/// it exists so that termination never has to wait behind a concurrent
/// [`Process::wait`].
#[derive(Clone, Debug)]
pub struct ProcessHandle {
    control: Arc<ProcessControl>,
    tasks: Arc<dyn VirtualTaskManager>,
    terminal: Option<Arc<TerminalBridge>>,
}

impl ProcessHandle {
    /// WASIX process identifier.
    #[must_use]
    pub fn id(&self) -> u32 {
        self.control.process.pid().raw()
    }

    /// Resize the attached terminal.
    ///
    /// # Errors
    ///
    /// Returns an error when this process was not spawned in terminal mode.
    pub fn resize_terminal(&self, columns: u32, rows: u32) -> Result<()> {
        let terminal = self.terminal.as_ref().ok_or_else(|| Error::Execution {
            message: "the process has no terminal".to_owned(),
        })?;
        terminal.resize(columns, rows);
        Ok(())
    }

    /// Immediately signal the guest with `SIGKILL`.
    pub fn kill(&self) {
        self.control.kill();
    }

    /// Request graceful termination and escalate to `SIGKILL` after `grace`.
    ///
    /// This waits at most `grace` for the guest to exit on its own; it does
    /// not join the process or return its output.
    pub async fn terminate(&self, grace: Duration) {
        if self.control.process.try_join().is_some() {
            return;
        }
        self.control.signal_terminate();
        let exited = Box::pin(self.control.process.join());
        let grace_elapsed = self.tasks.sleep_now(grace);
        if let Either::Right(((), exited)) = futures::future::select(exited, grace_elapsed).await {
            drop(exited);
            self.control.kill();
        }
    }

    pub(crate) async fn kill_on_timeout(&self, duration: Duration) {
        let exited = Box::pin(self.control.process.join());
        let deadline = self.tasks.sleep_now(duration);
        if let Either::Right(((), exited)) = futures::future::select(exited, deadline).await {
            drop(exited);
            self.control.kill_timed_out();
        }
    }
}

const EXIT_NONE: u8 = 0;
const EXIT_TERMINATED_GRACEFUL: u8 = 1;
const EXIT_TERMINATED_FORCED: u8 = 2;
const EXIT_TIMED_OUT: u8 = 3;

#[derive(Debug)]
pub(crate) struct ProcessControl {
    process: WasiProcess,
    stdin: Option<PipeCloser>,
    /// The first SDK-requested exit, if any. Once set it is never replaced,
    /// so a terminate that escalates to a kill still reports `Terminated`.
    exit: AtomicU8,
}

impl ProcessControl {
    pub(crate) fn signal_terminate(&self) {
        if !self.record_exit_if_running(EXIT_TERMINATED_GRACEFUL) {
            return;
        }
        self.process.signal_process(Signal::Sigterm);
        if let Some(stdin) = &self.stdin {
            stdin.close();
        }
    }

    pub(crate) fn kill(&self) {
        if !self.record_exit_if_running(EXIT_TERMINATED_FORCED) {
            return;
        }
        self.force_exit();
        if let Some(stdin) = &self.stdin {
            stdin.close();
        }
    }

    pub(crate) fn kill_timed_out(&self) {
        if !self.record_exit_if_running(EXIT_TIMED_OUT) {
            return;
        }
        self.force_exit();
        if let Some(stdin) = &self.stdin {
            stdin.close();
        }
    }

    fn force_exit(&self) {
        self.process.signal_process(Signal::Sigkill);
        // A wasm worker can be suspended inside an atomic wait while servicing
        // a WASIX syscall. SIGKILL disables and wakes those atomics, but there
        // is no native thread unwinder to publish the task's final status.
        // Complete the join state explicitly; client shutdown will then
        // terminate the worker if it has not unwound on its own.
        #[cfg(target_arch = "wasm32")]
        self.process.terminate(ExitCode::from(137));
    }

    pub(crate) fn try_join_exited(&self) -> bool {
        self.process.try_join().is_some()
    }

    fn record_exit_if_running(&self, requested: u8) -> bool {
        if self.try_join_exited() {
            return false;
        }
        let _ =
            self.exit
                .compare_exchange(EXIT_NONE, requested, Ordering::AcqRel, Ordering::Acquire);
        true
    }

    fn exit_state(&self, backend_code: i32) -> (ExitReason, ExitStatus) {
        match self.exit.load(Ordering::Acquire) {
            EXIT_TERMINATED_GRACEFUL => (ExitReason::Terminated, ExitStatus::from_code(143)),
            EXIT_TERMINATED_FORCED => (ExitReason::Terminated, ExitStatus::from_code(137)),
            EXIT_TIMED_OUT => (ExitReason::TimedOut, ExitStatus::from_code(137)),
            _ => (ExitReason::Exited, ExitStatus::from_code(backend_code)),
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.completed.is_none() && self.control.process.try_join().is_none() {
            self.control.kill();
        }
    }
}
