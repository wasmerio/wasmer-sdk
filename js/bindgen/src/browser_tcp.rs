//! Raw, bounded ingress streams for native clients of a browser-hosted guest.
use std::{pin::Pin, sync::Mutex, task::Poll};

use futures::future::poll_fn;
use js_sys::Uint8Array;
use tokio::io::{AsyncRead, ReadBuf};
use virtual_net::tcp_pair::{TcpSocketHalf, TcpSocketHalfRx, TcpSocketHalfTx};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = TcpConnectionCore)]
pub struct JsTcpConnection {
    reader: Mutex<TcpSocketHalfRx>,
    writer: TcpSocketHalfTx,
}

impl JsTcpConnection {
    pub(crate) fn new(socket: TcpSocketHalf) -> Self {
        let (writer, reader) = socket.split();
        Self {
            reader: Mutex::new(reader),
            writer,
        }
    }
}

#[wasm_bindgen(js_class = TcpConnectionCore)]
impl JsTcpConnection {
    /// Empty bytes indicate EOF. The caller must have only one read in flight.
    pub async fn read(&self) -> Result<Uint8Array, JsValue> {
        let mut bytes = vec![0; 64 * 1024];
        let count = poll_fn(|cx| {
            let mut reader = self.reader.lock().expect("TCP reader poisoned");
            let mut buffer = ReadBuf::new(&mut bytes);
            match Pin::new(&mut *reader).poll_read(cx, &mut buffer) {
                Poll::Ready(Ok(())) => Poll::Ready(Ok(buffer.filled().len())),
                Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                Poll::Pending => Poll::Pending,
            }
        })
        .await
        .map_err(crate::js_error)?;
        Ok(Uint8Array::from(&bytes[..count]))
    }

    /// Writes apply backpressure; submit chunks no larger than 64 KiB.
    pub async fn write(&self, bytes: Uint8Array) -> Result<(), JsValue> {
        if bytes.length() > 64 * 1024 {
            return Err(crate::custom_error(
                "INVALID_ARGUMENT",
                "TCP chunks must not exceed 64 KiB",
            ));
        }
        self.writer
            .send(bytes.to_vec().into())
            .await
            .map_err(crate::js_error)
    }

    #[wasm_bindgen(js_name = shutdownWrite)]
    pub fn shutdown_write(&self) -> Result<(), JsValue> {
        self.writer.close().map_err(crate::js_error)
    }

    /// Wakes pending reads/writes. Free only after their promises settle.
    pub fn close(&self) -> Result<(), JsValue> {
        self.writer.close().map_err(crate::js_error)?;
        self.reader
            .lock()
            .expect("TCP reader poisoned")
            .close()
            .map_err(crate::js_error)
    }
}
