use std::{
    collections::HashMap,
    mem::MaybeUninit,
    net::{IpAddr, Shutdown, SocketAddr},
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
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

    #[wasm_bindgen(method, getter)]
    fn id(this: &NodeNetworkBridge) -> u32;

    #[wasm_bindgen(method, js_name = setWakeCallback)]
    fn set_wake_callback(this: &NodeNetworkBridge, callback: &Function);

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostResolve)]
    fn node_resolve(bridge_id: u32, host: String) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostConnectTcp)]
    fn node_connect_tcp(
        bridge_id: u32,
        local: String,
        peer: String,
    ) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostListenTcp)]
    fn node_listen_tcp(bridge_id: u32, addr: String) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostListenerAccept)]
    fn node_listener_accept(bridge_id: u32, id: u32) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostListenerRefresh)]
    fn node_listener_refresh(bridge_id: u32, id: u32) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostListenerReadable)]
    fn node_listener_readable(bridge_id: u32, id: u32) -> Result<bool, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostListenerClose)]
    fn node_listener_close(bridge_id: u32, id: u32) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketRead)]
    fn node_socket_read(bridge_id: u32, id: u32, length: usize) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketWrite)]
    fn node_socket_write(bridge_id: u32, id: u32, data: &[u8]) -> Result<i32, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketFlush)]
    fn node_socket_flush(bridge_id: u32, id: u32) -> Result<bool, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketClose)]
    fn node_socket_close(bridge_id: u32, id: u32) -> Result<(), JsValue>;

    // `catch` is required on every hook: on worker threads these calls proxy
    // through the RPC channel, and a JavaScript throw through a non-`catch`
    // import would abort the wasm instance.
    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketReadable)]
    fn node_socket_readable(bridge_id: u32, id: u32) -> Result<i32, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketWritable)]
    fn node_socket_writable(bridge_id: u32, id: u32) -> Result<i32, JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketSetNoDelay)]
    fn node_socket_set_nodelay(bridge_id: u32, id: u32, enabled: bool) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketSetKeepAlive)]
    fn node_socket_set_keepalive(bridge_id: u32, id: u32, enabled: bool) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = globalThis, catch, js_name = __wasmerHostSocketRefresh)]
    fn node_socket_refresh(bridge_id: u32, id: u32) -> Result<(), JsValue>;

}

#[derive(Default)]
struct InterestState {
    handler: Option<Box<dyn InterestHandler + Send + Sync>>,
    read_wakers: Vec<Waker>,
    write_wakers: Vec<Waker>,
}

type HandlerMap = Arc<Mutex<HashMap<u32, InterestState>>>;

/// A WASIX virtual network whose descriptors are backed by a JavaScript
/// `NodeNetworkBridge`. The bridge itself owns `node:net` sockets.
#[derive(Clone)]
pub struct NodeNetworking {
    bridge_id: u32,
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
        let bridge_id = bridge.id();
        let handlers: HandlerMap = Arc::new(Mutex::new(HashMap::new()));
        let callback_handlers = Arc::clone(&handlers);
        let callback = Closure::wrap(Box::new(move |id: u32, event: String| {
            notify_handler(&callback_handlers, id, &event)
        }) as Box<dyn FnMut(u32, String) -> bool>);
        bridge.set_wake_callback(callback.as_ref().unchecked_ref());
        callback.forget();
        Self {
            bridge_id,
            handlers,
        }
    }
}

fn notify_handler(handlers: &HandlerMap, id: u32, event: &str) -> bool {
    let interest = match event {
        "readable" | "connection" => InterestType::Readable,
        "writable" | "drain" => InterestType::Writable,
        "close" => InterestType::Closed,
        _ => InterestType::Error,
    };
    let wakers = {
        // Browser callbacks execute on the main thread, where contended atomics
        // may not block. Let the JavaScript bridge retry on a later task rather
        // than entering Mutex::lock(), which uses Atomics.wait under wasm.
        let mut handlers = match handlers.try_lock() {
            Ok(handlers) => handlers,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return false,
        };
        let Some(state) = handlers.get_mut(&id) else {
            return true;
        };
        if let Some(handler) = state.handler.as_mut() {
            handler.push_interest(interest);
        }
        match interest {
            InterestType::Readable => std::mem::take(&mut state.read_wakers),
            InterestType::Writable => std::mem::take(&mut state.write_wakers),
            InterestType::Closed | InterestType::Error => {
                let mut wakers = std::mem::take(&mut state.read_wakers);
                wakers.append(&mut state.write_wakers);
                wakers
            }
        }
    };
    for waker in wakers {
        waker.wake();
    }
    true
}

fn register_handler(
    handlers: &HandlerMap,
    id: u32,
    handler: Box<dyn InterestHandler + Send + Sync>,
) -> virtual_net::Result<()> {
    handlers
        .lock()
        .map_err(|_| NetworkError::Lock)?
        .entry(id)
        .or_default()
        .handler = Some(handler);
    Ok(())
}

fn remove_handler(handlers: &HandlerMap, id: u32) {
    let mut handlers = handlers.lock().expect("network handler lock poisoned");
    let should_remove = if let Some(state) = handlers.get_mut(&id) {
        state.handler = None;
        state.read_wakers.is_empty() && state.write_wakers.is_empty()
    } else {
        false
    };
    if should_remove {
        handlers.remove(&id);
    }
}

fn register_waker(handlers: &HandlerMap, id: u32, interest: InterestType, waker: &Waker) {
    let mut handlers = handlers.lock().expect("network handler lock poisoned");
    let state = handlers.entry(id).or_default();
    let wakers = match interest {
        InterestType::Readable | InterestType::Closed | InterestType::Error => {
            &mut state.read_wakers
        }
        InterestType::Writable => &mut state.write_wakers,
    };
    if !wakers.iter().any(|registered| registered.will_wake(waker)) {
        wakers.push(waker.clone());
    }
}

fn unregister_waker(handlers: &HandlerMap, id: u32, interest: InterestType, waker: &Waker) {
    let mut handlers = handlers.lock().expect("network handler lock poisoned");
    let should_remove = if let Some(state) = handlers.get_mut(&id) {
        let wakers = match interest {
            InterestType::Readable | InterestType::Closed | InterestType::Error => {
                &mut state.read_wakers
            }
            InterestType::Writable => &mut state.write_wakers,
        };
        wakers.retain(|registered| !registered.will_wake(waker));
        state.handler.is_none() && state.read_wakers.is_empty() && state.write_wakers.is_empty()
    } else {
        false
    };
    if should_remove {
        handlers.remove(&id);
    }
}

fn poll_ready(
    handlers: &HandlerMap,
    id: u32,
    interest: InterestType,
    cx: &mut Context<'_>,
    mut query: impl FnMut() -> Result<Option<usize>, JsValue>,
) -> Poll<virtual_net::Result<usize>> {
    match query() {
        Ok(Some(ready)) => {
            unregister_waker(handlers, id, interest, cx.waker());
            return Poll::Ready(Ok(ready));
        }
        Ok(None) => {}
        Err(error) => {
            unregister_waker(handlers, id, interest, cx.waker());
            return Poll::Ready(Err(js_error(error)));
        }
    }

    // The bridge publishes readiness as an event, but readiness may change
    // between the first query and registering this task. Register, then query
    // the level again so neither ordering can lose the wakeup.
    register_waker(handlers, id, interest, cx.waker());
    match query() {
        Ok(Some(ready)) => {
            unregister_waker(handlers, id, interest, cx.waker());
            Poll::Ready(Ok(ready))
        }
        Ok(None) => Poll::Pending,
        Err(error) => {
            unregister_waker(handlers, id, interest, cx.waker());
            Poll::Ready(Err(js_error(error)))
        }
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
        let descriptor = node_listen_tcp(self.bridge_id, addr.to_string()).map_err(js_error)?;
        let id = number_property(&descriptor, "id")?;
        let local = address_property(&descriptor, "local")?;
        Ok(Box::new(NodeTcpListener {
            bridge_id: self.bridge_id,
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
            bridge_id: self.bridge_id,
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
        let descriptor = if has_global_function("__wasmerHostConnectTcpSync") {
            call_global_sync(
                "__wasmerHostConnectTcpSync",
                &[
                    JsValue::from(self.bridge_id),
                    JsValue::from(addr.to_string()),
                    JsValue::from(peer.to_string()),
                ],
            )
            .map_err(js_error)?
        } else {
            let promise = node_connect_tcp(self.bridge_id, addr.to_string(), peer.to_string())
                .map_err(js_error)?;
            JsSendFuture(JsFuture::from(promise))
                .await
                .map_err(js_error)?
        };
        Ok(Box::new(NodeTcpSocket::from_descriptor(
            descriptor,
            self.bridge_id,
            Arc::clone(&self.handlers),
        )?))
    }

    async fn resolve(
        &self,
        host: &str,
        _port: Option<u16>,
        _dns_server: Option<IpAddr>,
    ) -> virtual_net::Result<Vec<IpAddr>> {
        let values = if has_global_function("__wasmerHostResolveSync") {
            call_global_sync(
                "__wasmerHostResolveSync",
                &[JsValue::from(self.bridge_id), JsValue::from(host)],
            )
            .map_err(js_error)?
        } else {
            let promise = node_resolve(self.bridge_id, host.to_owned()).map_err(js_error)?;
            JsSendFuture(JsFuture::from(promise))
                .await
                .map_err(js_error)?
        };
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

fn has_global_function(name: &str) -> bool {
    let global = js_sys::global();
    Reflect::get(&global, &JsValue::from_str(name)).is_ok_and(|value| value.is_function())
}

fn call_global_sync(name: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let global = js_sys::global();
    let function = Reflect::get(&global, &JsValue::from_str(name))?.dyn_into::<Function>()?;
    let arguments = Array::new();
    for argument in args {
        arguments.push(argument);
    }
    function.apply(&global, &arguments)
}

struct NodeTcpBoundSocket {
    bridge_id: u32,
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
        let descriptor =
            node_listen_tcp(self.bridge_id, self.local.to_string()).map_err(js_error)?;
        let id = number_property(&descriptor, "id")?;
        let local = address_property(&descriptor, "local")?;
        Ok(Box::new(NodeTcpListener {
            bridge_id: self.bridge_id,
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
    bridge_id: u32,
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
        remove_handler(&self.handlers, self.id);
    }

    fn poll_read_ready(&mut self, cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        poll_ready(&self.handlers, self.id, InterestType::Readable, cx, || {
            node_listener_readable(self.bridge_id, self.id).map(|ready| ready.then_some(1))
        })
    }

    fn poll_write_ready(&mut self, _cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        Poll::Ready(Ok(1))
    }
}

impl VirtualTcpListener for NodeTcpListener {
    fn try_accept(
        &mut self,
    ) -> virtual_net::Result<(Box<dyn VirtualTcpSocket + Sync>, SocketAddr)> {
        let descriptor = node_listener_accept(self.bridge_id, self.id).map_err(js_error)?;
        if descriptor.is_undefined() || descriptor.is_null() {
            return Err(NetworkError::WouldBlock);
        }
        let socket =
            NodeTcpSocket::from_descriptor(descriptor, self.bridge_id, Arc::clone(&self.handlers))?;
        let peer = socket.peer;
        Ok((Box::new(socket), peer))
    }

    fn set_handler(
        &mut self,
        handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> virtual_net::Result<()> {
        register_handler(&self.handlers, self.id, handler)?;
        node_listener_refresh(self.bridge_id, self.id).map_err(js_error)?;
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
        let _ = node_listener_close(self.bridge_id, self.id);
        self.handlers
            .lock()
            .expect("handler lock poisoned")
            .remove(&self.id);
    }
}

struct NodeTcpSocket {
    bridge_id: u32,
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
    fn from_descriptor(
        descriptor: JsValue,
        bridge_id: u32,
        handlers: HandlerMap,
    ) -> virtual_net::Result<Self> {
        Ok(Self {
            bridge_id,
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
        remove_handler(&self.handlers, self.id);
    }

    fn poll_read_ready(&mut self, cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        poll_ready(&self.handlers, self.id, InterestType::Readable, cx, || {
            node_socket_readable(self.bridge_id, self.id)
                .map(|ready| (ready >= 0).then_some(ready.max(0) as usize))
        })
    }

    fn poll_write_ready(&mut self, cx: &mut Context<'_>) -> Poll<virtual_net::Result<usize>> {
        poll_ready(&self.handlers, self.id, InterestType::Writable, cx, || {
            node_socket_writable(self.bridge_id, self.id)
                .map(|ready| (ready >= 0).then_some(ready.max(0) as usize))
        })
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
        register_handler(&self.handlers, self.id, handler)?;
        // Readiness can change between the operation returning WouldBlock and
        // this handler being installed. Ask the Node bridge to publish its
        // current level-triggered state after registration completes.
        node_socket_refresh(self.bridge_id, self.id).map_err(js_error)?;
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
        let written = node_socket_write(self.bridge_id, self.id, data).map_err(js_error)?;
        if written < 0 {
            Err(NetworkError::WouldBlock)
        } else {
            Ok(written as usize)
        }
    }

    fn try_flush(&mut self) -> virtual_net::Result<()> {
        if node_socket_flush(self.bridge_id, self.id).map_err(js_error)? {
            Ok(())
        } else {
            Err(NetworkError::WouldBlock)
        }
    }

    fn close(&mut self) -> virtual_net::Result<()> {
        node_socket_close(self.bridge_id, self.id).map_err(js_error)?;
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
        let value = node_socket_read(self.bridge_id, self.id, buffer.len()).map_err(js_error)?;
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
        let readable = node_socket_readable(self.bridge_id, self.id).map_err(js_error)?;
        Ok(readable.max(0) as usize)
    }
    fn set_send_buf_size(&mut self, _size: usize) -> virtual_net::Result<()> {
        Ok(())
    }
    fn send_buf_size(&self) -> virtual_net::Result<usize> {
        let writable = node_socket_writable(self.bridge_id, self.id).map_err(js_error)?;
        Ok(writable.max(0) as usize)
    }
    fn set_nodelay(&mut self, enabled: bool) -> virtual_net::Result<()> {
        node_socket_set_nodelay(self.bridge_id, self.id, enabled).map_err(js_error)?;
        self.nodelay = enabled;
        Ok(())
    }
    fn nodelay(&self) -> virtual_net::Result<bool> {
        Ok(self.nodelay)
    }
    fn set_keepalive(&mut self, enabled: bool) -> virtual_net::Result<()> {
        node_socket_set_keepalive(self.bridge_id, self.id, enabled).map_err(js_error)?;
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
        let _ = node_socket_close(self.bridge_id, self.id);
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

/// Map a JavaScript bridge failure to the closest [`NetworkError`].
///
/// The original message is logged before mapping so a connection refused, a
/// DNS failure, and a missing bridge stay distinguishable in host diagnostics.
fn js_error(error: JsValue) -> NetworkError {
    let message = error
        .dyn_ref::<js_sys::Error>()
        .map(|error| String::from(error.message()))
        .or_else(|| error.as_string())
        .unwrap_or_else(|| format!("{error:?}"));
    // Debug level: readiness probes (`ports.wait`) legitimately hit
    // connection-refused until the guest listens, and must not spam logs.
    tracing::debug!(%message, "Node network bridge call failed");
    // node:net surfaces its errno code inside the message (ECONNREFUSED, …).
    if message.contains("ECONNREFUSED") {
        NetworkError::ConnectionRefused
    } else if message.contains("ECONNRESET") {
        NetworkError::ConnectionReset
    } else if message.contains("ECONNABORTED") {
        NetworkError::ConnectionAborted
    } else if message.contains("ETIMEDOUT") {
        NetworkError::TimedOut
    } else if message.contains("EADDRINUSE") {
        NetworkError::AddressInUse
    } else if message.contains("EADDRNOTAVAIL") || message.contains("ENOTFOUND") {
        NetworkError::AddressNotAvailable
    } else if message.contains("EPIPE") {
        NetworkError::BrokenPipe
    } else if message.contains("ENOTCONN") {
        NetworkError::NotConnected
    } else if message.contains("EACCES") || message.contains("EPERM") {
        NetworkError::PermissionDenied
    } else {
        NetworkError::IOError
    }
}
