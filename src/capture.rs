use std::{
    io::{self, IoSlice, SeekFrom},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};

use virtual_fs::{AsyncRead, AsyncSeek, AsyncWrite, VirtualFile};

#[derive(Clone, Debug)]
pub(crate) struct CaptureHandle {
    bytes: Arc<Mutex<Vec<u8>>>,
    truncated: Arc<AtomicBool>,
}

impl CaptureHandle {
    pub(crate) fn snapshot(&self) -> (Vec<u8>, bool) {
        (
            self.bytes.lock().expect("capture lock poisoned").clone(),
            self.truncated.load(Ordering::Acquire),
        )
    }

    pub(crate) fn retain(&self, bytes: &[u8], limit: usize) {
        let mut retained = self.bytes.lock().expect("capture lock poisoned");
        let available = limit.saturating_sub(retained.len());
        let amount = available.min(bytes.len());
        retained.extend_from_slice(&bytes[..amount]);
        if amount < bytes.len() {
            self.truncated.store(true, Ordering::Release);
        }
    }
}

#[derive(Debug)]
pub(crate) struct BoundedCapture {
    handle: CaptureHandle,
    limit: usize,
    cursor: u64,
}

impl BoundedCapture {
    pub(crate) fn new(limit: usize) -> (Self, CaptureHandle) {
        let handle = CaptureHandle {
            bytes: Arc::new(Mutex::new(Vec::with_capacity(limit.min(64 * 1024)))),
            truncated: Arc::new(AtomicBool::new(false)),
        };
        (
            Self {
                handle: handle.clone(),
                limit,
                cursor: 0,
            },
            handle,
        )
    }
}

impl AsyncWrite for BoundedCapture {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.handle.retain(buf, self.limit);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let total = bufs.iter().map(|buf| buf.len()).sum();
        for buf in bufs {
            let _ = self.as_mut().poll_write(cx, buf);
        }
        Poll::Ready(Ok(total))
    }
}

impl AsyncRead for BoundedCapture {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        destination: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let bytes = self.handle.bytes.lock().expect("capture lock poisoned");
        let start = usize::try_from(self.cursor).unwrap_or(usize::MAX);
        if start < bytes.len() {
            let amount = destination.remaining().min(bytes.len() - start);
            destination.put_slice(&bytes[start..start + amount]);
            drop(bytes);
            self.cursor += amount as u64;
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for BoundedCapture {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let len = self
            .handle
            .bytes
            .lock()
            .expect("capture lock poisoned")
            .len() as i128;
        let next = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => len + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.cursor) + i128::from(offset),
        };
        if next < 0 || next > i128::from(u64::MAX) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid capture seek",
            ));
        }
        self.cursor = u64::try_from(next)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid capture seek"))?;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.cursor))
    }
}

impl VirtualFile for BoundedCapture {
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
        self.handle
            .bytes
            .lock()
            .expect("capture lock poisoned")
            .len() as u64
    }

    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        let new_size = usize::try_from(new_size).map_err(|_| virtual_fs::FsError::InvalidInput)?;
        if new_size > self.limit {
            return Err(virtual_fs::FsError::InvalidInput);
        }
        self.handle
            .bytes
            .lock()
            .map_err(|_| virtual_fs::FsError::Lock)?
            .resize(new_size, 0);
        Ok(())
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let len = self
            .handle
            .bytes
            .lock()
            .expect("capture lock poisoned")
            .len() as u64;
        let available = usize::try_from(len.saturating_sub(self.cursor)).unwrap_or(usize::MAX);
        Poll::Ready(Ok(available))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}
