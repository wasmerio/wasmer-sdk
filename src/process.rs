use std::{
    io,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI32, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use wasmer_wasix::os::task::{TaskJoinHandle, process::WasiProcess};
use wasmer_wasix_types::wasi::Signal;

use crate::{CapturedOutput, Error, ExitStatus, Output, Result, capture::CaptureHandle};

/// Writable live stdin for a spawned guest process.
#[derive(Debug)]
pub struct ProcessStdin {
    inner: Arc<Mutex<Option<DuplexStream>>>,
}

impl ProcessStdin {
    pub(crate) fn new(inner: DuplexStream) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Some(inner))),
        }
    }

    pub(crate) fn clone_handle(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }

    pub(crate) fn close_now(&self) {
        self.inner.lock().expect("stdin lock poisoned").take();
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
        let mut inner = self.inner.lock().expect("stdin lock poisoned");
        let Some(stream) = inner.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        Pin::new(stream).poll_write(cx, bytes)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut inner = self.inner.lock().expect("stdin lock poisoned");
        let Some(stream) = inner.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        Pin::new(stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut inner = self.inner.lock().expect("stdin lock poisoned");
        let Some(stream) = inner.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(stream).poll_shutdown(cx) {
            Poll::Ready(result) => {
                inner.take();
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

macro_rules! process_output_stream {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Debug)]
        pub struct $name {
            inner: DuplexStream,
        }

        impl $name {
            pub(crate) fn new(inner: DuplexStream) -> Self {
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
    task: TaskJoinHandle,
    stdin: Option<ProcessStdin>,
    stdout: Option<ProcessStdout>,
    stderr: Option<ProcessStderr>,
    stdout_capture: CaptureHandle,
    stderr_capture: CaptureHandle,
    completed: Option<Output>,
}

impl Process {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        process: WasiProcess,
        task: TaskJoinHandle,
        stdin: Option<ProcessStdin>,
        stdout: Option<ProcessStdout>,
        stderr: Option<ProcessStderr>,
        stdout_capture: CaptureHandle,
        stderr_capture: CaptureHandle,
    ) -> Self {
        let stdin_control = stdin.as_ref().map(ProcessStdin::clone_handle);
        let control = Arc::new(ProcessControl {
            process,
            stdin: stdin_control,
            requested_exit: AtomicI32::new(0),
        });
        Self {
            id: control.process.pid().raw(),
            control,
            task,
            stdin,
            stdout,
            stderr,
            stdout_capture,
            stderr_capture,
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
        self.control.terminate();
        if let Ok(result) = tokio::time::timeout(grace, self.wait()).await {
            result?;
        } else {
            self.kill()?;
            self.wait().await?;
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
        Output {
            status: ExitStatus::from_code(self.control.normalized_exit(code)),
            stdout: CapturedOutput::from_parts(stdout, stdout_truncated),
            stderr: CapturedOutput::from_parts(stderr, stderr_truncated),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessControl {
    process: WasiProcess,
    stdin: Option<ProcessStdin>,
    requested_exit: AtomicI32,
}

impl ProcessControl {
    pub(crate) fn terminate(&self) {
        self.requested_exit.store(143, Ordering::Release);
        self.process.signal_process(Signal::Sigterm);
        if let Some(stdin) = &self.stdin {
            stdin.close_now();
        }
    }

    pub(crate) fn kill(&self) {
        self.requested_exit.store(137, Ordering::Release);
        self.process.signal_process(Signal::Sigkill);
        if let Some(stdin) = &self.stdin {
            stdin.close_now();
        }
    }

    fn normalized_exit(&self, backend_code: i32) -> i32 {
        match self.requested_exit.load(Ordering::Acquire) {
            0 => backend_code,
            requested => requested,
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
