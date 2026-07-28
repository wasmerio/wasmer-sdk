use std::{
    collections::HashMap,
    mem::MaybeUninit,
    net::{IpAddr, Shutdown, SocketAddr},
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use async_trait::async_trait;
use js_sys::{Array, Function, Reflect, Uint8Array};
use virtual_mio::InterestType;
use virtual_net::{
    InterestHandler, NetworkError, SocketStatus, VirtualConnectedSocket, VirtualIoSource,
    VirtualNetworking, VirtualSocket, VirtualTcpBoundSocket, VirtualTcpListener, VirtualTcpSocket,
};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use wasm_bindgen_futures::JsFuture;

use crate::task_manager::JsSendFuture;

#[wasm_bindgen]
extern "C" {
    #[derive(Clone, Debug)]
    pub type NodeNetworkBridge;

    #[wasm_bindgen(method, js_name = setWakeCallback)]
    fn set_wake_callback(this: &NodeNetworkBridge, callback: &Function);

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeResolve)]
    fn node_resolve(host: String) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeConnectTcp)]
    fn node_connect_tcp(local: String, peer: String) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeListenTcp)]
    fn node_listen_tcp(addr: String) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeListenerAccept)]
    fn node_listener_accept(id: u32) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeListenerClose)]
    fn node_listener_close(id: u32) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketRead)]
    fn node_socket_read(id: u32, length: usize) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketWrite)]
    fn node_socket_write(id: u32, data: &[u8]) -> Result<i32, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketFlush)]
    fn node_socket_flush(id: u32) -> Result<bool, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketClose)]
    fn node_socket_close(id: u32) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, js_name = __wasmerNodeSocketReadable)]
    fn node_socket_readable(id: u32) -> i32;

    #[wasm_bindgen(js_namespace = globalThis, js_name = __wasmerNodeSocketWritable)]
    fn node_socket_writable(id: u32) -> i32;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketSetNoDelay)]
    fn node_socket_set_nodelay(id: u32, enabled: bool) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerNodeSocketSetKeepAlive)]
    fn node_socket_set_keepalive(id: u32, enabled: bool) -> Result<(), JsValue>;
}

type HandlerMap = Arc<Mutex<HashMap<u32, Box<dyn InterestHandler + Send + Sync>>>>;

/// A WASIX virtual network whose descriptors are backed by a JavaScript
/// `NodeNetworkBridge`. The bridge itself owns `node:net` sockets.
#[derive(Clone)]
pub struct NodeNetworking {
    handlers: HandlerMap,
}

impl std::fmt::Debug for NodeNetworking {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NodeNetworking")
            .finish_non_exhaustive()
    }
}

impl NodeNetworking {
    pub fn new(bridge: NodeNetworkBridge) -> Self {
        let handlers: HandlerMap = Arc::new(Mutex::new(HashMap::new()));
        let callback_handlers = Arc::clone(&handlers);
        let callback = Closure::wrap(Box::new(move |id: u32, event: String| {
            let interest = match event.as_str() {
                "readable" | "connection" => InterestType::Readable,
                "writable" | "drain" => InterestType::Writable,
                "close" => InterestType::Closed,
                _ => InterestType::Error,
            };
            if let Some(handler) = callback_handlers
                .lock()
                .expect("network handler lock poisoned")
                .get_mut(&id)
            {
                handler.push_interest(interest);
            }
        }) as Box<dyn FnMut(u32, String)>);
        bridge.set_wake_callback(callback.as_ref().unchecked_ref());
        callback.forget();
        Self { handlers }
    }
}

#[async_trait]
impl VirtualNetworking for NodeNetworking {
    async fn listen_tcp(
        &self,
        addr: SocketAddr,
        _only_v6: bool,
        _reuse_port: bool,
        _reuse_addr: bool,
    ) -> virtual_net::Result<Box<dyn VirtualTcpListener + Sync>> {
        let descriptor = node_listen_tcp(addr.to_string()).map_err(js_error)?;
        let id = number_property(&descriptor, "id")?;
        let local = address_property(&descriptor, "local")?;
        Ok(Box::new(NodeTcpListener {
            id,
            local,
            handlers: Arc::clone(&self.handlers),
        }))
    }

    async fn bind_tcp(
        &self,
        addr: SocketAddr,
        _only_v6: bool,
        _reuse_port: bool,
        _reuse_addr: bool,
    ) -> virtual_net::Result<Box<dyn VirtualTcpBoundSocket + Sync>> {
        Ok(Box::new(NodeTcpBoundSocket {
            local: addr,
            handlers: Arc::clone(&self.handlers),
            ttl: 64,
        }))
    }

    async fn connect_tcp(
        &self,
        addr: SocketAddr,
        peer: SocketAddr,
    ) -> virtual_net::Result<Box<dyn VirtualTcpSocket + Sync>> {
        let promise = node_connect_tcp(addr.to_string(), peer.to_string()).map_err(js_error)?;
        let descriptor = JsSendFuture(JsFuture::from(promise))
            .await
            .map_err(js_error)?;
        Ok(Box::new(NodeTcpSocket::from_descriptor(
            descriptor,
            Arc::clone(&self.handlers),
        )?))
    }

    async fn resolve(
        &self,
        host: &str,
        _port: Option<u16>,
        _dns_server: Option<IpAddr>,
    ) -> virtual_net::Result<Vec<IpAddr>> {
        let promise = node_resolve(host.to_owned()).map_err(js_error)?;
        let values = JsSendFuture(JsFuture::from(promise))
            .await
            .map_err(js_error)?;
        Array::from(&values)
            .iter()
            .map(|value| {
                value
                    .as_string()
                    .ok_or(NetworkError::InvalidData)?
                    .parse()
                    .map_err(|_| NetworkError::InvalidData)
            })
            .collect()
    }
}

struct NodeTcpBoundSocket {
    local: SocketAddr,
    handlers: HandlerMap,
    ttl: u32,
}

impl std::fmt::Debug for NodeTcpBoundSocket {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NodeTcpBoundSocket")
            .field("local", &self.local)
            .finish()
    }
}

impl VirtualTcpBoundSocket for NodeTcpBoundSocket {
    fn addr_local(&self) -> virtual_net::Result<SocketAddr> {
        Ok(self.local)
    }

    fn listen(&mut self) -> virtual_net::Result<Box<dyn VirtualTcpListener + Sync>> {
        let descriptor = node_listen_tcp(self.local.to_string()).map_err(js_error)?;
        let id = number_property(&descriptor, "id")?;
        let local = address_property(&descriptor, "local")?;
        Ok(Box::new(NodeTcpListener {
            id,
            local,
            handlers: Arc::clone(&self.handlers),
        }))
    }

    fn connect(
        &mut self,
        _peer: SocketAddr,
    ) -> virtual_net::Result<Box<dyn VirtualTcpSocket + Sync>> {
        Err(NetworkError::Unsupported)
    }

    fn set_ttl(&mut self, ttl: u32) -> virtual_net::Result<()> {
        self.ttl = ttl;
        Ok(())
    }

    fn ttl(&self) -> virtual_net::Result<u32> {
        Ok(self.ttl)
    }
}

struct NodeTcpListener {
    id: u32,
    local: SocketAddr,
    handlers: HandlerMap,
}

impl std::fmt::Debug for NodeTcpListener {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NodeTcpListener")
            .field("id", &self.id)
            .field("local", &self.local)
            .finish()
    }
}

impl VirtualIoSource for NodeTcpListener {
    fn remove_handler(&mut self) {
        self.handlers
            .lock()
            .expect("handler lock poisoned")
            .remove(&self.id);
    }

    fn poll_read_ready(&mut self, _cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        Poll::Ready(Ok(1))
    }

    fn poll_write_ready(&mut self, _cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        Poll::Ready(Ok(1))
    }
}

impl VirtualTcpListener for NodeTcpListener {
    fn try_accept(
        &mut self,
    ) -> virtual_net::Result<(Box<dyn VirtualTcpSocket + Sync>, SocketAddr)> {
        let descriptor = node_listener_accept(self.id).map_err(js_error)?;
        if descriptor.is_undefined() || descriptor.is_null() {
            return Err(NetworkError::WouldBlock);
        }
        let socket = NodeTcpSocket::from_descriptor(descriptor, Arc::clone(&self.handlers))?;
        let peer = socket.peer;
        Ok((Box::new(socket), peer))
    }

    fn set_handler(
        &mut self,
        handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> virtual_net::Result<()> {
        self.handlers
            .lock()
            .map_err(|_| NetworkError::Lock)?
            .insert(self.id, handler);
        Ok(())
    }

    fn addr_local(&self) -> virtual_net::Result<SocketAddr> {
        Ok(self.local)
    }

    fn set_ttl(&mut self, _ttl: u8) -> virtual_net::Result<()> {
        Ok(())
    }

    fn ttl(&self) -> virtual_net::Result<u8> {
        Ok(64)
    }
}

impl Drop for NodeTcpListener {
    fn drop(&mut self) {
        let _ = node_listener_close(self.id);
        self.handlers
            .lock()
            .expect("handler lock poisoned")
            .remove(&self.id);
    }
}

struct NodeTcpSocket {
    id: u32,
    local: SocketAddr,
    peer: SocketAddr,
    handlers: HandlerMap,
    closed: bool,
    nodelay: bool,
    keepalive: bool,
    linger: Option<Duration>,
}

impl std::fmt::Debug for NodeTcpSocket {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NodeTcpSocket")
            .field("id", &self.id)
            .field("local", &self.local)
            .field("peer", &self.peer)
            .finish()
    }
}

impl NodeTcpSocket {
    fn from_descriptor(descriptor: JsValue, handlers: HandlerMap) -> virtual_net::Result<Self> {
        Ok(Self {
            id: number_property(&descriptor, "id")?,
            local: address_property(&descriptor, "local")?,
            peer: address_property(&descriptor, "peer")?,
            handlers,
            closed: false,
            nodelay: false,
            keepalive: false,
            linger: None,
        })
    }
}

impl VirtualIoSource for NodeTcpSocket {
    fn remove_handler(&mut self) {
        self.handlers
            .lock()
            .expect("handler lock poisoned")
            .remove(&self.id);
    }

    fn poll_read_ready(&mut self, _cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        match node_socket_readable(self.id) {
            value if value >= 0 => Poll::Ready(Ok(value as usize)),
            _ => Poll::Pending,
        }
    }

    fn poll_write_ready(&mut self, _cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        match node_socket_writable(self.id) {
            value if value >= 0 => Poll::Ready(Ok(value as usize)),
            _ => Poll::Pending,
        }
    }
}

impl VirtualSocket for NodeTcpSocket {
    fn set_ttl(&mut self, _ttl: u32) -> virtual_net::Result<()> {
        Ok(())
    }

    fn ttl(&self) -> virtual_net::Result<u32> {
        Ok(64)
    }

    fn addr_local(&self) -> virtual_net::Result<SocketAddr> {
        Ok(self.local)
    }

    fn status(&self) -> virtual_net::Result<SocketStatus> {
        Ok(if self.closed {
            SocketStatus::Closed
        } else {
            SocketStatus::Opened
        })
    }

    fn set_handler(
        &mut self,
        handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> virtual_net::Result<()> {
        self.handlers
            .lock()
            .map_err(|_| NetworkError::Lock)?
            .insert(self.id, handler);
        Ok(())
    }
}

impl VirtualConnectedSocket for NodeTcpSocket {
    fn set_linger(&mut self, linger: Option<Duration>) -> virtual_net::Result<()> {
        self.linger = linger;
        Ok(())
    }

    fn linger(&self) -> virtual_net::Result<Option<Duration>> {
        Ok(self.linger)
    }

    fn try_send(&mut self, data: &[u8]) -> virtual_net::Result<usize> {
        let written = node_socket_write(self.id, data).map_err(js_error)?;
        if written < 0 {
            Err(NetworkError::WouldBlock)
        } else {
            Ok(written as usize)
        }
    }

    fn try_flush(&mut self) -> virtual_net::Result<()> {
        if node_socket_flush(self.id).map_err(js_error)? {
            Ok(())
        } else {
            Err(NetworkError::WouldBlock)
        }
    }

    fn close(&mut self) -> virtual_net::Result<()> {
        node_socket_close(self.id).map_err(js_error)?;
        self.closed = true;
        Ok(())
    }

    fn try_recv(
        &mut self,
        buffer: &mut [MaybeUninit<u8>],
        peek: bool,
    ) -> virtual_net::Result<usize> {
        if peek {
            return Err(NetworkError::Unsupported);
        }
        let value = node_socket_read(self.id, buffer.len()).map_err(js_error)?;
        if value.is_undefined() {
            return Err(NetworkError::WouldBlock);
        }
        if value.is_null() {
            self.closed = true;
            return Ok(0);
        }
        let bytes = Uint8Array::new(&value).to_vec();
        let length = bytes.len().min(buffer.len());
        for (destination, byte) in buffer.iter_mut().zip(bytes.iter()).take(length) {
            destination.write(*byte);
        }
        Ok(length)
    }
}

impl VirtualTcpSocket for NodeTcpSocket {
    fn set_recv_buf_size(&mut self, _size: usize) -> virtual_net::Result<()> {
        Ok(())
    }
    fn recv_buf_size(&self) -> virtual_net::Result<usize> {
        Ok(node_socket_readable(self.id).max(0) as usize)
    }
    fn set_send_buf_size(&mut self, _size: usize) -> virtual_net::Result<()> {
        Ok(())
    }
    fn send_buf_size(&self) -> virtual_net::Result<usize> {
        Ok(node_socket_writable(self.id).max(0) as usize)
    }
    fn set_nodelay(&mut self, enabled: bool) -> virtual_net::Result<()> {
        node_socket_set_nodelay(self.id, enabled).map_err(js_error)?;
        self.nodelay = enabled;
        Ok(())
    }
    fn nodelay(&self) -> virtual_net::Result<bool> {
        Ok(self.nodelay)
    }
    fn set_keepalive(&mut self, enabled: bool) -> virtual_net::Result<()> {
        node_socket_set_keepalive(self.id, enabled).map_err(js_error)?;
        self.keepalive = enabled;
        Ok(())
    }
    fn keepalive(&self) -> virtual_net::Result<bool> {
        Ok(self.keepalive)
    }
    fn set_dontroute(&mut self, _enabled: bool) -> virtual_net::Result<()> {
        Ok(())
    }
    fn dontroute(&self) -> virtual_net::Result<bool> {
        Ok(false)
    }
    fn addr_peer(&self) -> virtual_net::Result<SocketAddr> {
        Ok(self.peer)
    }
    fn shutdown(&mut self, _how: Shutdown) -> virtual_net::Result<()> {
        self.close()
    }
    fn is_closed(&self) -> bool {
        self.closed
    }
}

impl Drop for NodeTcpSocket {
    fn drop(&mut self) {
        let _ = node_socket_close(self.id);
        self.handlers
            .lock()
            .expect("handler lock poisoned")
            .remove(&self.id);
    }
}

fn number_property(value: &JsValue, name: &str) -> virtual_net::Result<u32> {
    Reflect::get(value, &JsValue::from_str(name))
        .map_err(js_error)?
        .as_f64()
        .and_then(|value| u32::try_from(value as u64).ok())
        .ok_or(NetworkError::InvalidData)
}

fn address_property(value: &JsValue, name: &str) -> virtual_net::Result<SocketAddr> {
    Reflect::get(value, &JsValue::from_str(name))
        .map_err(js_error)?
        .as_string()
        .ok_or(NetworkError::InvalidData)?
        .parse()
        .map_err(|_| NetworkError::InvalidData)
}

fn js_error(_error: JsValue) -> NetworkError {
    NetworkError::IOError
}
