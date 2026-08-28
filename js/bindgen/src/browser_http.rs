//! An in-memory HTTP ingress network for browser sandboxes.
//!
//! A service worker cannot open a TCP connection to a WASIX process. This
//! adapter presents HTTP requests as accepted TCP sockets instead: the guest
//! reads an ordinary HTTP/1.1 request and writes an ordinary HTTP response.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr},
    sync::{Arc, Mutex, TryLockError, Weak},
    task::{Context, Poll, Waker},
};

use bytes::{Bytes, BytesMut};
use http::{Method, Request, Response};
use tokio::sync::oneshot;
use virtual_mio::{InterestHandler, InterestType};
use virtual_net::{
    IpCidr, NetworkError, SocketStatus, VirtualConnectedSocket, VirtualIoSource, VirtualNetworking,
    VirtualSocket, VirtualTcpBoundSocket, VirtualTcpListener, VirtualTcpSocket,
};

use crate::node_network::NodeNetworking;

type NetworkResult<T> = virtual_net::Result<T>;

#[derive(Debug)]
struct ActiveRequest {
    request: Request<Bytes>,
    peer_addr: SocketAddr,
    response: oneshot::Sender<NetworkResult<Response<Bytes>>>,
}

#[derive(Debug, Default)]
struct NetworkState {
    listeners: HashMap<SocketAddr, Weak<Mutex<ListenerState>>>,
    bound: HashSet<SocketAddr>,
    ip_addresses: Vec<IpCidr>,
}

/// Virtual network installed into sandboxes configured with `network: http`.
#[derive(Clone, Debug, Default)]
pub(crate) struct BrowserHttpNetworking {
    state: Arc<Mutex<NetworkState>>,
    egress: Option<NodeNetworking>,
}

/// Main-thread handle used by the service-worker transport.
#[derive(Clone, Debug)]
pub(crate) struct BrowserHttpRequestHandler {
    state: Arc<Mutex<NetworkState>>,
}

impl BrowserHttpNetworking {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn request_handler(&self) -> BrowserHttpRequestHandler {
        BrowserHttpRequestHandler {
            state: Arc::clone(&self.state),
        }
    }

    pub(crate) fn with_egress(egress: NodeNetworking) -> Self {
        Self {
            state: Arc::default(),
            egress: Some(egress),
        }
    }
}

impl BrowserHttpRequestHandler {
    pub(crate) fn has_listener(&self, port: u16) -> bool {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock) => return false,
            Err(TryLockError::Poisoned(_)) => panic!("browser HTTP network poisoned"),
        };
        state
            .listeners
            .retain(|_, listener| listener.strong_count() > 0);
        state.listeners.keys().any(|address| address.port() == port)
    }

    pub(crate) fn listening_ports(&self) -> Option<Vec<u16>> {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock) => return None,
            Err(TryLockError::Poisoned(_)) => panic!("browser HTTP network poisoned"),
        };
        state
            .listeners
            .retain(|_, listener| listener.strong_count() > 0);
        let mut ports: Vec<_> = state.listeners.keys().map(SocketAddr::port).collect();
        ports.sort_unstable();
        ports.dedup();
        Some(ports)
    }

    pub(crate) async fn handle(
        &self,
        request: Request<Bytes>,
        port: u16,
    ) -> NetworkResult<Response<Bytes>> {
        let receiver = {
            let state = self.state.lock().expect("browser HTTP network poisoned");
            let (address, listener) = state
                .listeners
                .iter()
                .find_map(|(address, listener)| {
                    (address.port() == port)
                        .then(|| listener.upgrade().map(|listener| (*address, listener)))
                        .flatten()
                })
                .ok_or(NetworkError::ConnectionRefused)?;
            drop(state);
            let peer_addr = match address {
                SocketAddr::V4(_) => SocketAddr::new(Ipv4Addr::new(127, 0, 0, 100).into(), 50_000),
                SocketAddr::V6(_) => SocketAddr::new(Ipv6Addr::LOCALHOST.into(), 50_000),
            };
            let (sender, receiver) = oneshot::channel();
            BrowserHttpListener {
                state: listener,
                local_addr: address,
            }
            .push(ActiveRequest {
                request,
                peer_addr,
                response: sender,
            });
            receiver
        };

        receiver.await.unwrap_or(Err(NetworkError::NotConnected))
    }
}

#[async_trait::async_trait]
impl VirtualNetworking for BrowserHttpNetworking {
    async fn dhcp_acquire(&self) -> NetworkResult<Vec<IpAddr>> {
        let mut state = self.state.lock().expect("browser HTTP network poisoned");
        state.ip_addresses = vec![
            IpCidr {
                ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                prefix: 32,
            },
            IpCidr {
                ip: IpAddr::V6(Ipv6Addr::LOCALHOST),
                prefix: 128,
            },
        ];
        Ok(state.ip_addresses.iter().map(|cidr| cidr.ip).collect())
    }

    async fn ip_add(&self, ip: IpAddr, prefix: u8) -> NetworkResult<()> {
        self.state
            .lock()
            .expect("browser HTTP network poisoned")
            .ip_addresses
            .push(IpCidr { ip, prefix });
        Ok(())
    }

    async fn ip_remove(&self, ip: IpAddr) -> NetworkResult<()> {
        self.state
            .lock()
            .expect("browser HTTP network poisoned")
            .ip_addresses
            .retain(|cidr| cidr.ip != ip);
        Ok(())
    }

    async fn ip_clear(&self) -> NetworkResult<()> {
        self.state
            .lock()
            .expect("browser HTTP network poisoned")
            .ip_addresses
            .clear();
        Ok(())
    }

    async fn ip_list(&self) -> NetworkResult<Vec<IpCidr>> {
        Ok(self
            .state
            .lock()
            .expect("browser HTTP network poisoned")
            .ip_addresses
            .clone())
    }

    async fn listen_tcp(
        &self,
        address: SocketAddr,
        _only_v6: bool,
        _reuse_port: bool,
        _reuse_addr: bool,
    ) -> NetworkResult<Box<dyn VirtualTcpListener + Sync>> {
        let address = normalize_listener_address(address);
        let listener = BrowserHttpListener::new(address);
        let mut state = self.state.lock().expect("browser HTTP network poisoned");
        if state.bound.contains(&address)
            || state
                .listeners
                .get(&address)
                .is_some_and(|listener| listener.strong_count() > 0)
        {
            return Err(NetworkError::AddressInUse);
        }
        state
            .listeners
            .insert(address, Arc::downgrade(&listener.state));
        Ok(Box::new(listener))
    }

    async fn bind_tcp(
        &self,
        address: SocketAddr,
        _only_v6: bool,
        _reuse_port: bool,
        _reuse_addr: bool,
    ) -> NetworkResult<Box<dyn VirtualTcpBoundSocket + Sync>> {
        let address = normalize_listener_address(address);
        let mut state = self.state.lock().expect("browser HTTP network poisoned");
        if state.bound.contains(&address)
            || state
                .listeners
                .get(&address)
                .is_some_and(|listener| listener.strong_count() > 0)
        {
            return Err(NetworkError::AddressInUse);
        }
        state.bound.insert(address);
        Ok(Box::new(BrowserHttpBoundSocket {
            networking: self.clone(),
            address,
            reserved: true,
            ttl: 64,
        }))
    }

    async fn connect_tcp(
        &self,
        local: SocketAddr,
        peer: SocketAddr,
    ) -> NetworkResult<Box<dyn VirtualTcpSocket + Sync>> {
        let egress = self.egress.as_ref().ok_or(NetworkError::Unsupported)?;
        egress.connect_tcp(local, peer).await
    }

    async fn resolve(
        &self,
        host: &str,
        port: Option<u16>,
        dns_server: Option<IpAddr>,
    ) -> NetworkResult<Vec<IpAddr>> {
        let egress = self.egress.as_ref().ok_or(NetworkError::Unsupported)?;
        egress.resolve(host, port, dns_server).await
    }
}

fn normalize_listener_address(address: SocketAddr) -> SocketAddr {
    match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), address.port())
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::new(Ipv6Addr::LOCALHOST.into(), address.port())
        }
        _ => address,
    }
}

#[derive(Debug, Default)]
struct ListenerState {
    backlog: VecDeque<ActiveRequest>,
    handler: Option<Box<dyn InterestHandler + Send + Sync>>,
    wakers: Vec<Waker>,
}

#[derive(Clone, Debug)]
struct BrowserHttpListener {
    state: Arc<Mutex<ListenerState>>,
    local_addr: SocketAddr,
}

#[derive(Debug)]
struct BrowserHttpBoundSocket {
    networking: BrowserHttpNetworking,
    address: SocketAddr,
    reserved: bool,
    ttl: u32,
}

impl BrowserHttpBoundSocket {
    fn release(&mut self) {
        if self.reserved {
            self.networking
                .state
                .lock()
                .expect("browser HTTP network poisoned")
                .bound
                .remove(&self.address);
            self.reserved = false;
        }
    }
}

impl Drop for BrowserHttpBoundSocket {
    fn drop(&mut self) {
        self.release();
    }
}

impl VirtualTcpBoundSocket for BrowserHttpBoundSocket {
    fn addr_local(&self) -> NetworkResult<SocketAddr> {
        Ok(self.address)
    }

    fn listen(&mut self) -> NetworkResult<Box<dyn VirtualTcpListener + Sync>> {
        if !self.reserved {
            return Err(NetworkError::InvalidFd);
        }
        let listener = BrowserHttpListener::new(self.address);
        let mut state = self
            .networking
            .state
            .lock()
            .expect("browser HTTP network poisoned");
        if !state.bound.remove(&self.address) {
            return Err(NetworkError::InvalidFd);
        }
        state
            .listeners
            .insert(self.address, Arc::downgrade(&listener.state));
        self.reserved = false;
        Ok(Box::new(listener))
    }

    fn connect(&mut self, _peer: SocketAddr) -> NetworkResult<Box<dyn VirtualTcpSocket + Sync>> {
        Err(NetworkError::Unsupported)
    }

    fn set_ttl(&mut self, ttl: u32) -> NetworkResult<()> {
        self.ttl = ttl;
        Ok(())
    }

    fn ttl(&self) -> NetworkResult<u32> {
        Ok(self.ttl)
    }
}

impl BrowserHttpListener {
    fn new(local_addr: SocketAddr) -> Self {
        Self {
            state: Arc::new(Mutex::new(ListenerState::default())),
            local_addr,
        }
    }

    fn push(&mut self, request: ActiveRequest) {
        let mut state = self.state.lock().expect("browser HTTP listener poisoned");
        state.backlog.push_back(request);
        if let Some(handler) = state.handler.as_mut() {
            handler.push_interest(InterestType::Readable);
        }
        for waiter in state.wakers.drain(..) {
            waiter.wake();
        }
    }
}

impl VirtualIoSource for BrowserHttpListener {
    fn remove_handler(&mut self) {
        self.state
            .lock()
            .expect("browser HTTP listener poisoned")
            .handler
            .take();
    }

    fn poll_read_ready(&mut self, context: &mut Context<'_>) -> Poll<NetworkResult<usize>> {
        let mut state = self.state.lock().expect("browser HTTP listener poisoned");
        if !state.backlog.is_empty() {
            return Poll::Ready(Ok(state.backlog.len()));
        }
        if !state
            .wakers
            .iter()
            .any(|waiter| waiter.will_wake(context.waker()))
        {
            state.wakers.push(context.waker().clone());
        }
        Poll::Pending
    }

    fn poll_write_ready(&mut self, _context: &mut Context<'_>) -> Poll<NetworkResult<usize>> {
        Poll::Pending
    }
}

impl VirtualTcpListener for BrowserHttpListener {
    fn try_accept(&mut self) -> NetworkResult<(Box<dyn VirtualTcpSocket + Sync>, SocketAddr)> {
        let request = self
            .state
            .lock()
            .expect("browser HTTP listener poisoned")
            .backlog
            .pop_front()
            .ok_or(NetworkError::WouldBlock)?;
        let peer_addr = request.peer_addr;
        Ok((
            Box::new(BrowserHttpSocket::new(self.local_addr, request)),
            peer_addr,
        ))
    }

    fn set_handler(
        &mut self,
        mut handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> NetworkResult<()> {
        let mut state = self.state.lock().expect("browser HTTP listener poisoned");
        if !state.backlog.is_empty() {
            handler.push_interest(InterestType::Readable);
        }
        state.handler = Some(handler);
        Ok(())
    }

    fn addr_local(&self) -> NetworkResult<SocketAddr> {
        Ok(self.local_addr)
    }

    fn set_ttl(&mut self, _ttl: u8) -> NetworkResult<()> {
        Ok(())
    }

    fn ttl(&self) -> NetworkResult<u8> {
        Ok(64)
    }
}

#[derive(Debug)]
struct SocketState {
    request: Option<RequestBytes>,
    response: Option<ResponseBytes>,
    handler: Option<Box<dyn InterestHandler + Send + Sync>>,
}

#[derive(Debug)]
struct RequestBytes {
    bytes: Bytes,
    offset: usize,
}

#[derive(Debug)]
struct ResponseBytes {
    bytes: BytesMut,
    sender: Option<oneshot::Sender<NetworkResult<Response<Bytes>>>>,
    request_method: Method,
}

#[derive(Debug)]
struct BrowserHttpSocket {
    state: Arc<Mutex<SocketState>>,
    local_addr: SocketAddr,
    peer_addr: SocketAddr,
}

impl BrowserHttpSocket {
    fn new(local_addr: SocketAddr, request: ActiveRequest) -> Self {
        let request_method = request.request.method().clone();
        let bytes = serialize_request(request.request);
        Self {
            state: Arc::new(Mutex::new(SocketState {
                request: Some(RequestBytes { bytes, offset: 0 }),
                response: Some(ResponseBytes {
                    bytes: BytesMut::new(),
                    sender: Some(request.response),
                    request_method,
                }),
                handler: None,
            })),
            local_addr,
            peer_addr: request.peer_addr,
        }
    }

    fn readable_bytes(state: &SocketState) -> usize {
        state
            .request
            .as_ref()
            .map_or(0, |request| request.bytes.len() - request.offset)
    }

    fn finish_response(state: &mut SocketState, eof: bool) {
        let Some(response) = state.response.as_mut() else {
            return;
        };
        let Some(sender) = response.sender.take() else {
            return;
        };
        match parse_response(&response.bytes, &response.request_method, eof) {
            Ok(Some(parsed)) => {
                let _ = sender.send(Ok(parsed));
            }
            Ok(None) => response.sender = Some(sender),
            Err(error) => {
                let _ = sender.send(Err(error));
            }
        }
    }
}

impl VirtualIoSource for BrowserHttpSocket {
    fn remove_handler(&mut self) {
        self.state
            .lock()
            .expect("browser HTTP socket poisoned")
            .handler
            .take();
    }

    fn poll_read_ready(&mut self, _context: &mut Context<'_>) -> Poll<NetworkResult<usize>> {
        let readable =
            Self::readable_bytes(&self.state.lock().expect("browser HTTP socket poisoned"));
        if readable > 0 {
            Poll::Ready(Ok(readable))
        } else {
            // The browser-side request is complete, but its connection remains
            // open while the guest prepares the response. Reporting zero here
            // would be interpreted as EOF and Node would close the writable
            // half of the accepted socket before asynchronous handlers can run.
            Poll::Pending
        }
    }

    fn poll_write_ready(&mut self, _context: &mut Context<'_>) -> Poll<NetworkResult<usize>> {
        let state = self.state.lock().expect("browser HTTP socket poisoned");
        Poll::Ready(Ok(if state.response.is_some() {
            64 * 1024
        } else {
            0
        }))
    }
}

impl VirtualSocket for BrowserHttpSocket {
    fn set_ttl(&mut self, _ttl: u32) -> NetworkResult<()> {
        Ok(())
    }

    fn ttl(&self) -> NetworkResult<u32> {
        Ok(64)
    }

    fn addr_local(&self) -> NetworkResult<SocketAddr> {
        Ok(self.local_addr)
    }

    fn status(&self) -> NetworkResult<SocketStatus> {
        let state = self.state.lock().expect("browser HTTP socket poisoned");
        Ok(if state.response.is_some() {
            SocketStatus::Opened
        } else {
            SocketStatus::Closed
        })
    }

    fn set_handler(
        &mut self,
        mut handler: Box<dyn InterestHandler + Send + Sync>,
    ) -> NetworkResult<()> {
        let mut state = self.state.lock().expect("browser HTTP socket poisoned");
        if Self::readable_bytes(&state) > 0 {
            handler.push_interest(InterestType::Readable);
        }
        if state.response.is_some() {
            handler.push_interest(InterestType::Writable);
        }
        state.handler = Some(handler);
        Ok(())
    }
}

impl VirtualConnectedSocket for BrowserHttpSocket {
    fn set_linger(&mut self, _linger: Option<std::time::Duration>) -> NetworkResult<()> {
        Ok(())
    }

    fn linger(&self) -> NetworkResult<Option<std::time::Duration>> {
        Ok(None)
    }

    fn try_send(&mut self, data: &[u8]) -> NetworkResult<usize> {
        let mut state = self.state.lock().expect("browser HTTP socket poisoned");
        let response = state.response.as_mut().ok_or(NetworkError::NotConnected)?;
        response.bytes.extend_from_slice(data);
        Self::finish_response(&mut state, false);
        Ok(data.len())
    }

    fn try_flush(&mut self) -> NetworkResult<()> {
        Ok(())
    }

    fn close(&mut self) -> NetworkResult<()> {
        self.shutdown(Shutdown::Both)
    }

    fn try_recv(
        &mut self,
        buffer: &mut [std::mem::MaybeUninit<u8>],
        peek: bool,
    ) -> NetworkResult<usize> {
        let mut state = self.state.lock().expect("browser HTTP socket poisoned");
        let Some(request) = state.request.as_mut() else {
            return Err(NetworkError::WouldBlock);
        };
        let available = &request.bytes[request.offset..];
        let count = available.len().min(buffer.len());
        for (slot, byte) in buffer.iter_mut().zip(&available[..count]) {
            slot.write(*byte);
        }
        if !peek {
            request.offset += count;
            if request.offset == request.bytes.len() {
                state.request = None;
            }
        }
        Ok(count)
    }
}

impl VirtualTcpSocket for BrowserHttpSocket {
    fn set_recv_buf_size(&mut self, _size: usize) -> NetworkResult<()> {
        Ok(())
    }

    fn recv_buf_size(&self) -> NetworkResult<usize> {
        Ok(64 * 1024)
    }

    fn set_send_buf_size(&mut self, _size: usize) -> NetworkResult<()> {
        Ok(())
    }

    fn send_buf_size(&self) -> NetworkResult<usize> {
        Ok(64 * 1024)
    }

    fn set_nodelay(&mut self, _enabled: bool) -> NetworkResult<()> {
        Ok(())
    }

    fn nodelay(&self) -> NetworkResult<bool> {
        Ok(true)
    }

    fn set_keepalive(&mut self, _enabled: bool) -> NetworkResult<()> {
        Ok(())
    }

    fn keepalive(&self) -> NetworkResult<bool> {
        Ok(false)
    }

    fn set_dontroute(&mut self, _enabled: bool) -> NetworkResult<()> {
        Ok(())
    }

    fn dontroute(&self) -> NetworkResult<bool> {
        Ok(false)
    }

    fn addr_peer(&self) -> NetworkResult<SocketAddr> {
        Ok(self.peer_addr)
    }

    fn shutdown(&mut self, direction: Shutdown) -> NetworkResult<()> {
        let mut state = self.state.lock().expect("browser HTTP socket poisoned");
        if matches!(direction, Shutdown::Read | Shutdown::Both) {
            state.request = None;
        }
        if matches!(direction, Shutdown::Write | Shutdown::Both) {
            Self::finish_response(&mut state, true);
            state.response = None;
        }
        Ok(())
    }

    fn is_closed(&self) -> bool {
        self.state
            .lock()
            .expect("browser HTTP socket poisoned")
            .response
            .is_none()
    }
}

impl Drop for BrowserHttpSocket {
    fn drop(&mut self) {
        let mut state = self.state.lock().expect("browser HTTP socket poisoned");
        Self::finish_response(&mut state, true);
    }
}

fn serialize_request(request: Request<Bytes>) -> Bytes {
    let (mut parts, body) = request.into_parts();
    parts.headers.remove(http::header::CONNECTION);
    parts.headers.insert(
        http::header::CONNECTION,
        http::HeaderValue::from_static("close"),
    );
    if !body.is_empty() {
        parts.headers.insert(
            http::header::CONTENT_LENGTH,
            http::HeaderValue::from_str(&body.len().to_string())
                .expect("a byte length is a valid header value"),
        );
    }

    let mut bytes = BytesMut::new();
    bytes.extend_from_slice(parts.method.as_str().as_bytes());
    bytes.extend_from_slice(b" ");
    bytes.extend_from_slice(
        parts
            .uri
            .path_and_query()
            .map_or("/", http::uri::PathAndQuery::as_str)
            .as_bytes(),
    );
    bytes.extend_from_slice(b" HTTP/1.1\r\n");
    for (name, value) in &parts.headers {
        bytes.extend_from_slice(name.as_str().as_bytes());
        bytes.extend_from_slice(b": ");
        bytes.extend_from_slice(value.as_bytes());
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"\r\n");
    bytes.extend_from_slice(&body);
    bytes.freeze()
}

fn parse_response(
    bytes: &[u8],
    request_method: &Method,
    eof: bool,
) -> NetworkResult<Option<Response<Bytes>>> {
    let mut headers = [httparse::EMPTY_HEADER; 128];
    let mut parsed = httparse::Response::new(&mut headers);
    let header_bytes = match parsed.parse(bytes).map_err(|_| NetworkError::InvalidData)? {
        httparse::Status::Partial => {
            return if eof {
                Err(NetworkError::InvalidData)
            } else {
                Ok(None)
            };
        }
        httparse::Status::Complete(length) => length,
    };
    let status = parsed.code.ok_or(NetworkError::InvalidData)?;
    let no_body = request_method == Method::HEAD
        || (100..200).contains(&status)
        || status == 204
        || status == 304;
    let content_length = parsed
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("content-length"))
        .map(|header| {
            std::str::from_utf8(header.value)
                .ok()
                .and_then(|value| value.trim().parse::<usize>().ok())
                .ok_or(NetworkError::InvalidData)
        })
        .transpose()?;
    let chunked = parsed.headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("transfer-encoding")
            && std::str::from_utf8(header.value)
                .is_ok_and(|value| value.to_ascii_lowercase().contains("chunked"))
    });

    let body = &bytes[header_bytes..];
    let body = if no_body {
        Bytes::new()
    } else if chunked {
        match decode_chunked(body)? {
            Some(body) => Bytes::from(body),
            None if !eof => return Ok(None),
            None => return Err(NetworkError::InvalidData),
        }
    } else if let Some(length) = content_length {
        if body.len() < length {
            return if eof {
                Err(NetworkError::InvalidData)
            } else {
                Ok(None)
            };
        }
        Bytes::copy_from_slice(&body[..length])
    } else if eof {
        Bytes::copy_from_slice(body)
    } else {
        return Ok(None);
    };

    let mut response = Response::builder().status(status);
    for header in parsed.headers.iter().filter(|header| {
        !header.name.eq_ignore_ascii_case("connection")
            && !header.name.eq_ignore_ascii_case("transfer-encoding")
            && !header.name.eq_ignore_ascii_case("host")
    }) {
        response = response.header(header.name, header.value);
    }
    response
        .body(body)
        .map(Some)
        .map_err(|_| NetworkError::InvalidData)
}

fn decode_chunked(mut bytes: &[u8]) -> NetworkResult<Option<Vec<u8>>> {
    let mut decoded = Vec::new();
    loop {
        let Some(line_end) = bytes.windows(2).position(|window| window == b"\r\n") else {
            return Ok(None);
        };
        let size = std::str::from_utf8(&bytes[..line_end])
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|value| usize::from_str_radix(value.trim(), 16).ok())
            .ok_or(NetworkError::InvalidData)?;
        bytes = &bytes[line_end + 2..];
        if size == 0 {
            return if bytes.windows(4).any(|window| window == b"\r\n\r\n")
                || bytes.starts_with(b"\r\n")
            {
                Ok(Some(decoded))
            } else {
                Ok(None)
            };
        }
        if bytes.len() < size + 2 {
            return Ok(None);
        }
        decoded.extend_from_slice(&bytes[..size]);
        if &bytes[size..size + 2] != b"\r\n" {
            return Err(NetworkError::InvalidData);
        }
        bytes = &bytes[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use std::{mem::MaybeUninit, task::Waker};

    use super::*;

    #[test]
    fn listener_observers_never_block_on_network_mutation() {
        let networking = BrowserHttpNetworking::new();
        let handler = networking.request_handler();
        let _mutation = networking
            .state
            .lock()
            .expect("browser HTTP network poisoned");

        assert!(!handler.has_listener(8000));
        assert_eq!(handler.listening_ports(), None);
    }

    #[test]
    fn exhausted_request_stays_open_for_an_async_response() {
        let (response, _receiver) = oneshot::channel();
        let request = Request::builder()
            .method(Method::GET)
            .uri("/")
            .body(Bytes::new())
            .unwrap();
        let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 8000);
        let mut socket = BrowserHttpSocket::new(
            address,
            ActiveRequest {
                request,
                peer_addr: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 50_000),
                response,
            },
        );

        let request_len = BrowserHttpSocket::readable_bytes(
            &socket.state.lock().expect("browser HTTP socket poisoned"),
        );
        let mut buffer = vec![MaybeUninit::uninit(); request_len];
        assert_eq!(socket.try_recv(&mut buffer, false).unwrap(), request_len);
        assert!(matches!(
            socket.try_recv(&mut buffer, false),
            Err(NetworkError::WouldBlock)
        ));

        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(
            socket.poll_read_ready(&mut context),
            Poll::Pending
        ));
    }
}
