//! Existing SDK bounded output retention adapted to the v2 host byte sink.
use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use wasixv2_host::{ByteSink, LocalFuture};

#[derive(Clone)]
pub(crate) struct Capture {
    bytes: Arc<Mutex<Vec<u8>>>,
    truncated: Arc<AtomicBool>,
    limit: usize,
}

impl Capture {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            bytes: Arc::new(Mutex::new(Vec::with_capacity(limit.min(64 * 1024)))),
            truncated: Arc::new(AtomicBool::new(false)),
            limit,
        }
    }

    pub(crate) fn snapshot(&self) -> (Vec<u8>, bool) {
        (
            self.bytes.lock().expect("capture lock poisoned").clone(),
            self.truncated.load(Ordering::Acquire),
        )
    }

    fn retain(&self, bytes: &[u8]) {
        let mut retained = self.bytes.lock().expect("capture lock poisoned");
        let amount = self.limit.saturating_sub(retained.len()).min(bytes.len());
        retained.extend_from_slice(&bytes[..amount]);
        if amount < bytes.len() {
            self.truncated.store(true, Ordering::Release);
        }
    }
}

/// Pipe mode retains exactly the bytes accepted by the bounded live transport.
/// Capture mode has no pipe and accepts all bytes; discard has neither owner.
pub(crate) struct OutputSink {
    pipe: Option<Arc<dyn ByteSink>>,
    capture: Option<Capture>,
}

impl OutputSink {
    pub(crate) fn new(pipe: Option<Arc<dyn ByteSink>>, capture: Option<Capture>) -> Self {
        Self { pipe, capture }
    }
}

impl ByteSink for OutputSink {
    fn write<'a>(&'a self, bytes: &'a [u8]) -> LocalFuture<'a, io::Result<usize>> {
        Box::pin(async move {
            let written = match &self.pipe {
                Some(pipe) => pipe.write(bytes).await?,
                None => bytes.len(),
            };
            if written > bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid output write count",
                ));
            }
            if let Some(capture) = &self.capture {
                capture.retain(&bytes[..written]);
            }
            Ok(written)
        })
    }
}
