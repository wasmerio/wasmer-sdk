use std::{
    io::{self, SeekFrom},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};

use futures::task::AtomicWaker;
use tokio::{
    io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf},
    sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
};
use virtual_fs::VirtualFile;

use crate::capture::CaptureHandle;

const MAX_PIPE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug)]
enum PipeMessage {
    Data(Vec<u8>),
    Close,
}

#[derive(Debug)]
struct PipeState {
    buffered: AtomicUsize,
    capacity: usize,
    closed: AtomicBool,
    writer_waker: AtomicWaker,
}

/// Create a byte-bounded asynchronous pipe without a blocking mutex.
///
/// Tokio's `DuplexStream` uses a synchronous mutex internally. That mutex may
/// call `Atomics.wait` when contended on wasm, which browsers prohibit on the
/// window thread. This pipe transports owned chunks through Tokio's lock-free
/// unbounded channel and enforces byte capacity independently with atomics.
pub(crate) fn bounded_pipe(capacity: usize) -> (PipeReader, PipeWriter, PipeCloser) {
    let (sender, receiver) = unbounded_channel();
    let state = Arc::new(PipeState {
        buffered: AtomicUsize::new(0),
        capacity: capacity.max(1),
        closed: AtomicBool::new(false),
        writer_waker: AtomicWaker::new(),
    });
    (
        PipeReader {
            receiver,
            state: Arc::clone(&state),
            pending: None,
            offset: 0,
            eof: false,
        },
        PipeWriter {
            sender: sender.clone(),
            state: Arc::clone(&state),
        },
        PipeCloser { sender, state },
    )
}

#[derive(Clone, Debug)]
pub(crate) struct PipeCloser {
    sender: UnboundedSender<PipeMessage>,
    state: Arc<PipeState>,
}

impl PipeCloser {
    pub(crate) fn close(&self) {
        if !self.state.closed.swap(true, Ordering::AcqRel) {
            let _ = self.sender.send(PipeMessage::Close);
            self.state.writer_waker.wake();
        }
    }
}

#[derive(Debug)]
pub(crate) struct PipeReader {
    receiver: UnboundedReceiver<PipeMessage>,
    state: Arc<PipeState>,
    pending: Option<Vec<u8>>,
    offset: usize,
    eof: bool,
}

impl PipeReader {
    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if let Some(pending) = &self.pending {
            return Poll::Ready(Ok(pending.len().saturating_sub(self.offset)));
        }
        if self.eof {
            return Poll::Ready(Ok(0));
        }

        loop {
            match self.receiver.poll_recv(cx) {
                Poll::Ready(Some(PipeMessage::Data(bytes))) if bytes.is_empty() => continue,
                Poll::Ready(Some(PipeMessage::Data(bytes))) => {
                    let available = bytes.len();
                    self.pending = Some(bytes);
                    self.offset = 0;
                    return Poll::Ready(Ok(available));
                }
                Poll::Ready(Some(PipeMessage::Close) | None) => {
                    self.eof = true;
                    return Poll::Ready(Ok(0));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl AsyncRead for PipeReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 || self.eof {
            return Poll::Ready(Ok(()));
        }
        let initially_filled = buffer.filled().len();

        loop {
            if let Some(pending) = self.pending.take() {
                let available = &pending[self.offset..];
                let read = available.len().min(buffer.remaining());
                buffer.put_slice(&available[..read]);
                self.offset += read;
                self.state.buffered.fetch_sub(read, Ordering::AcqRel);
                self.state.writer_waker.wake();

                if self.offset < pending.len() {
                    self.pending = Some(pending);
                } else {
                    self.offset = 0;
                }
                if buffer.remaining() == 0 {
                    return Poll::Ready(Ok(()));
                }
                continue;
            }

            match self.receiver.poll_recv(cx) {
                Poll::Ready(Some(PipeMessage::Data(bytes))) => {
                    self.pending = Some(bytes);
                }
                Poll::Ready(Some(PipeMessage::Close) | None) => {
                    self.eof = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Pending if buffer.filled().len() > initially_filled => {
                    return Poll::Ready(Ok(()));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl Drop for PipeReader {
    fn drop(&mut self) {
        self.receiver.close();
        self.state.closed.store(true, Ordering::Release);
        self.state.writer_waker.wake();
    }
}

#[derive(Debug)]
pub(crate) struct PipeWriter {
    sender: UnboundedSender<PipeMessage>,
    state: Arc<PipeState>,
}

impl PipeWriter {
    fn poll_capacity(&self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if self.state.closed.load(Ordering::Acquire) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }

        let buffered = self.state.buffered.load(Ordering::Acquire);
        if buffered < self.state.capacity {
            return Poll::Ready(Ok(self.state.capacity - buffered));
        }

        self.state.writer_waker.register(cx.waker());
        if self.state.closed.load(Ordering::Acquire) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        let buffered = self.state.buffered.load(Ordering::Acquire);
        if buffered < self.state.capacity {
            Poll::Ready(Ok(self.state.capacity - buffered))
        } else {
            Poll::Pending
        }
    }

    fn close(&self) {
        if !self.state.closed.swap(true, Ordering::AcqRel) {
            let _ = self.sender.send(PipeMessage::Close);
            self.state.writer_waker.wake();
        }
    }
}

impl AsyncWrite for PipeWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }

        loop {
            let available = match self.poll_capacity(cx) {
                Poll::Ready(Ok(available)) => available,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            };
            let written = bytes.len().min(available).min(MAX_PIPE_CHUNK_BYTES);
            let buffered = self.state.buffered.load(Ordering::Acquire);
            if buffered >= self.state.capacity {
                continue;
            }
            let written = written.min(self.state.capacity - buffered);
            if self
                .state
                .buffered
                .compare_exchange_weak(
                    buffered,
                    buffered + written,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
            {
                continue;
            }

            if self.state.closed.load(Ordering::Acquire) {
                self.state.buffered.fetch_sub(written, Ordering::AcqRel);
                return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
            }
            if self
                .sender
                .send(PipeMessage::Data(bytes[..written].to_vec()))
                .is_err()
            {
                self.state.buffered.fetch_sub(written, Ordering::AcqRel);
                return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
            }
            return Poll::Ready(Ok(written));
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.close();
        Poll::Ready(Ok(()))
    }
}

impl Drop for PipeWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Debug)]
pub(crate) struct PipeVirtualFile {
    reader: Option<PipeReader>,
    writer: Option<PipeWriter>,
}

impl PipeVirtualFile {
    pub(crate) fn reader(reader: PipeReader) -> Self {
        Self {
            reader: Some(reader),
            writer: None,
        }
    }

    pub(crate) fn writer(writer: PipeWriter) -> Self {
        Self {
            reader: None,
            writer: Some(writer),
        }
    }
}

impl AsyncRead for PipeVirtualFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let Some(reader) = self.reader.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        Pin::new(reader).poll_read(cx, buffer)
    }
}

impl AsyncWrite for PipeVirtualFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let Some(writer) = self.writer.as_mut() else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        Pin::new(writer).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(writer) = self.writer.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        Pin::new(writer).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(writer) = self.writer.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        Pin::new(writer).poll_shutdown(cx)
    }
}

impl AsyncSeek for PipeVirtualFile {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for PipeVirtualFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(virtual_fs::FsError::Unsupported)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let Some(reader) = self.reader.as_mut() else {
            return Poll::Ready(Ok(0));
        };
        Pin::new(reader).poll_read_ready(cx)
    }

    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(writer) = &this.writer else {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        };
        writer.poll_capacity(cx)
    }
}

#[derive(Debug)]
pub(crate) struct RetainedOutput {
    inner: PipeVirtualFile,
    capture: CaptureHandle,
}

impl RetainedOutput {
    pub(crate) fn new(inner: PipeWriter, capture: CaptureHandle) -> Self {
        Self {
            inner: PipeVirtualFile::writer(inner),
            capture,
        }
    }
}

impl AsyncRead for RetainedOutput {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buffer)
    }
}

impl AsyncWrite for RetainedOutput {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.inner).poll_write(cx, bytes) {
            Poll::Ready(Ok(written)) => {
                self.capture.retain(&bytes[..written]);
                Poll::Ready(Ok(written))
            }
            result => result,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl AsyncSeek for RetainedOutput {
    fn start_seek(self: Pin<&mut Self>, _position: SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for RetainedOutput {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
        Err(virtual_fs::FsError::Unsupported)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    use futures::task::noop_waker_ref;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::bounded_pipe;

    #[tokio::test]
    async fn pipe_preserves_bytes_and_delivers_eof() {
        let (mut reader, mut writer, _closer) = bounded_pipe(4);
        let write = async {
            writer.write_all(b"abcdefgh").await.unwrap();
            writer.shutdown().await.unwrap();
        };
        let read = async {
            let mut output = Vec::new();
            reader.read_to_end(&mut output).await.unwrap();
            output
        };

        let ((), output) = tokio::join!(write, read);
        assert_eq!(output, b"abcdefgh");
    }

    #[tokio::test]
    async fn external_close_wakes_both_ends() {
        let (mut reader, mut writer, closer) = bounded_pipe(1);
        writer.write_all(b"x").await.unwrap();
        closer.close();

        let mut output = Vec::new();
        reader.read_to_end(&mut output).await.unwrap();
        assert_eq!(output, b"x");
        assert_eq!(
            writer.write_all(b"y").await.unwrap_err().kind(),
            std::io::ErrorKind::BrokenPipe
        );
    }

    #[tokio::test]
    async fn read_readiness_waits_for_data_and_reports_eof() {
        let (mut reader, mut writer, _closer) = bounded_pipe(4);
        let mut cx = Context::from_waker(noop_waker_ref());

        assert!(matches!(
            Pin::new(&mut reader).poll_read_ready(&mut cx),
            Poll::Pending
        ));

        writer.write_all(b"x").await.unwrap();
        assert!(matches!(
            Pin::new(&mut reader).poll_read_ready(&mut cx),
            Poll::Ready(Ok(1))
        ));

        let mut byte = [0];
        reader.read_exact(&mut byte).await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(matches!(
            Pin::new(&mut reader).poll_read_ready(&mut cx),
            Poll::Ready(Ok(0))
        ));
    }
}
