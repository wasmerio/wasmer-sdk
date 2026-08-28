#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::missing_errors_doc,
    clippy::missing_fields_in_debug,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value,
    clippy::type_complexity
)]

mod browser_http;
mod node_network;
mod package_cache;
mod task_manager;
mod tasks;
mod worker_utils;

use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use browser_http::{BrowserHttpNetworking, BrowserHttpRequestHandler};
use bytes::Bytes;
use http::{Request as HttpRequest, header::HOST};
use js_sys::Uint8Array;
use node_network::{NodeNetworkBridge, NodeNetworking};
use once_cell::sync::Lazy;
use package_cache::{HostPackageCache, NodeCacheBridge};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use wasm_bindgen::prelude::*;
use wasmer_sdk::{
    Command, NetworkPolicy, Output, Package, PackageSource, Process, ProcessHandle, ProcessStderr,
    ProcessStdin, ProcessStdout, Sandbox, SandboxBuilder, Stdio, TerminalOptions, Wasmer,
    WasmerConfig,
};
use wasmer_wasix::PluggableRuntime;
use wasmer_wasix::runtime::{DefaultTty, package_loader::PackageCache, resolver::QueryCache};

pub use tasks::ThreadPoolWorker;

pub(crate) static CUSTOM_WORKER_URL: Lazy<StdMutex<Option<String>>> = Lazy::new(StdMutex::default);
pub(crate) static CUSTOM_SDK_URL: Lazy<StdMutex<Option<String>>> = Lazy::new(StdMutex::default);

#[wasm_bindgen(start)]
fn initialize() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(js_name = setSDKUrl)]
pub fn set_sdk_url(url: String) {
    *CUSTOM_SDK_URL.lock().expect("SDK URL lock poisoned") = Some(url);
}

#[wasm_bindgen(js_name = setWorkerUrl)]
pub fn set_worker_url(url: String) {
    *CUSTOM_WORKER_URL.lock().expect("worker URL lock poisoned") = Some(url);
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientOptions {
    output_bytes: Option<f64>,
    parallelism: Option<f64>,
    cache: Option<ClientCacheOptions>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientCacheOptions {
    mode: Option<String>,
    namespace: Option<String>,
    read_only: Option<bool>,
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_WASM32_SIZE: u64 = u32::MAX as u64;

#[wasm_bindgen(js_name = WasmerCore)]
pub struct JsWasmer {
    inner: Wasmer,
    tasks: Arc<tasks::ThreadPool>,
}

#[wasm_bindgen(js_class = WasmerCore)]
impl JsWasmer {
    #[wasm_bindgen(js_name = create)]
    pub fn create(
        options: JsValue,
        node_network: Option<NodeNetworkBridge>,
        node_cache: Option<NodeCacheBridge>,
    ) -> Result<Self, JsValue> {
        let options: ClientOptions = if options.is_null() || options.is_undefined() {
            ClientOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options).map_err(js_error)?
        };
        let parallelism = options
            .parallelism
            .map(|value| validate_usize("parallelism", value, 1))
            .transpose()?
            .and_then(std::num::NonZeroUsize::new);
        let tasks = Arc::new(tasks::ThreadPool::new(parallelism));
        let mut runtime = PluggableRuntime::new(Arc::clone(&tasks) as Arc<_>);
        runtime.set_tty(Arc::new(DefaultTty::default()));
        if let Some(bridge) = node_network {
            runtime.set_networking_implementation(NodeNetworking::new(bridge));
        }
        let config = WasmerConfig {
            output_bytes: options
                .output_bytes
                .map(|bytes| validate_usize("outputBytes", bytes, 0))
                .transpose()?
                .unwrap_or(16 * 1024 * 1024),
            ..WasmerConfig::default()
        };
        let cache = match options
            .cache
            .as_ref()
            .and_then(|cache| cache.mode.as_deref())
        {
            Some("disabled" | "memory") => None,
            Some("node") => {
                let bridge = node_cache.as_ref().ok_or_else(|| {
                    custom_error(
                        "INITIALIZATION_ERROR",
                        "the Node package cache bridge was not provided",
                    )
                })?;
                Some(Arc::new(HostPackageCache::node(bridge)))
            }
            Some("browser") | None => Some(Arc::new(HostPackageCache::browser(
                options
                    .cache
                    .as_ref()
                    .and_then(|cache| cache.namespace.as_deref()),
                options
                    .cache
                    .as_ref()
                    .and_then(|cache| cache.read_only)
                    .unwrap_or(false),
            ))),
            Some(other) => {
                return Err(custom_error(
                    "INVALID_ARGUMENT",
                    &format!("unsupported cache mode `{other}`"),
                ));
            }
        };
        let query_cache = cache.clone().map(|cache| -> Arc<dyn QueryCache> { cache });
        let package_cache = cache.map(|cache| -> Arc<dyn PackageCache> { cache });
        let inner = Wasmer::from_js_runtime(&config, runtime, query_cache, package_cache)
            .map_err(sdk_error)?;
        Ok(Self { inner, tasks })
    }

    #[wasm_bindgen(js_name = loadPackage)]
    pub async fn load_package(&self, specifier: String) -> Result<JsPackage, JsValue> {
        self.inner
            .packages()
            .load(specifier)
            .await
            .map(|inner| JsPackage { inner })
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = loadPackageBytes)]
    pub async fn load_package_bytes(&self, bytes: Uint8Array) -> Result<JsPackage, JsValue> {
        self.inner
            .packages()
            .load(PackageSource::webc(bytes.to_vec()))
            .await
            .map(|inner| JsPackage { inner })
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = sandbox)]
    pub fn sandbox(&self) -> JsSandboxBuilder {
        JsSandboxBuilder {
            inner: Some(self.inner.sandboxes().create()),
            browser_http: None,
        }
    }

    pub async fn shutdown(&self) -> Result<(), JsValue> {
        self.inner.shutdown().await.map_err(sdk_error)?;
        self.tasks.close_and_wait().await;
        Ok(())
    }
}

#[wasm_bindgen(js_name = PackageCore)]
pub struct JsPackage {
    inner: Package,
}

#[wasm_bindgen(js_class = PackageCore)]
impl JsPackage {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id()
    }

    #[wasm_bindgen(getter)]
    pub fn commands(&self) -> Vec<String> {
        self.inner.commands()
    }

    #[wasm_bindgen(getter)]
    pub fn entrypoint(&self) -> Option<String> {
        self.inner.entrypoint()
    }

    #[wasm_bindgen(js_name = hasCommand)]
    pub fn has_command(&self, name: String) -> bool {
        self.inner.command(name).is_ok()
    }
}

#[wasm_bindgen(js_name = SandboxBuilderCore)]
pub struct JsSandboxBuilder {
    inner: Option<SandboxBuilder>,
    browser_http: Option<BrowserHttpRequestHandler>,
}

#[wasm_bindgen(js_class = SandboxBuilderCore)]
impl JsSandboxBuilder {
    pub fn package(&mut self, package: &JsPackage) -> Result<(), JsValue> {
        let builder = self.take()?.package(package.inner.clone());
        self.inner = Some(builder);
        Ok(())
    }

    pub fn file(&mut self, path: String, bytes: Uint8Array) -> Result<(), JsValue> {
        let builder = self.take()?.file(path, bytes.to_vec());
        self.inner = Some(builder);
        Ok(())
    }

    pub fn env(&mut self, key: String, value: String) -> Result<(), JsValue> {
        let builder = self.take()?.env(key, value);
        self.inner = Some(builder);
        Ok(())
    }

    /// Configure guest networking from a stable mode string.
    pub fn network(&mut self, mode: String) -> Result<(), JsValue> {
        let builder = self.take()?;
        let builder = match mode.as_str() {
            "disabled" => {
                self.browser_http = None;
                builder.network(NetworkPolicy::Disabled)
            }
            "host" => {
                self.browser_http = None;
                builder.network(NetworkPolicy::Host)
            }
            "http" => {
                let networking = BrowserHttpNetworking::new();
                self.browser_http = Some(networking.request_handler());
                builder.network_provider(Arc::new(networking))
            }
            other => {
                return Err(custom_error(
                    "CAPABILITY_UNAVAILABLE",
                    &format!("unsupported network mode `{other}`"),
                ));
            }
        };
        self.inner = Some(builder);
        Ok(())
    }

    /// Configure browser HTTP ingress and WISP-backed TCP/DNS egress.
    #[wasm_bindgen(js_name = networkWisp)]
    pub fn network_wisp(&mut self, bridge: NodeNetworkBridge) -> Result<(), JsValue> {
        let builder = self.take()?;
        let networking = BrowserHttpNetworking::with_egress(NodeNetworking::new(bridge));
        self.browser_http = Some(networking.request_handler());
        self.inner = Some(builder.network_provider(Arc::new(networking)));
        Ok(())
    }

    pub async fn start(mut self) -> Result<JsSandbox, JsValue> {
        let builder = self.take()?;
        builder
            .await
            .map(|inner| JsSandbox {
                inner,
                browser_http: self.browser_http,
            })
            .map_err(sdk_error)
    }
}

impl JsSandboxBuilder {
    fn take(&mut self) -> Result<SandboxBuilder, JsValue> {
        self.inner
            .take()
            .ok_or_else(|| custom_error("TARGET_ERROR", "sandbox builder was already consumed"))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JsFileStat {
    kind: &'static str,
    size: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JsDirEntry {
    name: String,
    kind: &'static str,
    size: f64,
}

fn stat_parts(metadata: &wasmer_sdk::FileMetadata) -> (&'static str, f64) {
    let kind = match metadata.file_type {
        wasmer_sdk::FileType::Directory => "directory",
        wasmer_sdk::FileType::File => "file",
    };
    #[allow(clippy::cast_precision_loss)]
    (kind, metadata.len as f64)
}

#[wasm_bindgen(js_name = SandboxCore)]
pub struct JsSandbox {
    inner: Sandbox,
    browser_http: Option<BrowserHttpRequestHandler>,
}

#[wasm_bindgen(js_class = SandboxCore)]
impl JsSandbox {
    pub fn command(&self, name: String) -> JsCommand {
        JsCommand {
            inner: Some(self.inner.command(name)),
        }
    }

    #[wasm_bindgen(js_name = commandPackage)]
    pub fn command_package(&self, package: &JsPackage) -> JsCommand {
        JsCommand {
            inner: Some(self.inner.command(package.inner.clone())),
        }
    }

    /// A command explicitly qualified by its package, resolving name
    /// collisions between installed packages.
    #[wasm_bindgen(js_name = commandRef)]
    pub fn command_ref(&self, package: &JsPackage, name: String) -> Result<JsCommand, JsValue> {
        let reference = package.inner.command(name).map_err(sdk_error)?;
        Ok(JsCommand {
            inner: Some(self.inner.command(reference)),
        })
    }

    #[wasm_bindgen(js_name = installPackage)]
    pub async fn install_package(&self, specifier: String) -> Result<JsPackage, JsValue> {
        self.inner
            .install_package(specifier)
            .await
            .map(|inner| JsPackage { inner })
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = installPackageBytes)]
    pub async fn install_package_bytes(&self, bytes: Uint8Array) -> Result<JsPackage, JsValue> {
        self.inner
            .install_package(PackageSource::webc(bytes.to_vec()))
            .await
            .map(|inner| JsPackage { inner })
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = installPackageRef)]
    pub async fn install_package_ref(&self, package: &JsPackage) -> Result<JsPackage, JsValue> {
        self.inner
            .install_package(package.inner.clone())
            .await
            .map(|inner| JsPackage { inner })
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = writeFile)]
    pub async fn write_file(&self, path: String, bytes: Uint8Array) -> Result<(), JsValue> {
        self.inner
            .fs()
            .write(path, bytes.to_vec())
            .await
            .map_err(sdk_error)
    }

    #[wasm_bindgen(js_name = readFile)]
    pub async fn read_file(&self, path: String) -> Result<Uint8Array, JsValue> {
        self.inner
            .fs()
            .read(path)
            .await
            .map(|bytes| Uint8Array::from(bytes.as_slice()))
            .map_err(sdk_error)
    }

    pub fn mkdir(&self, path: String, recursive: bool) -> Result<(), JsValue> {
        if recursive {
            self.inner.fs().create_dir_all(path).map_err(sdk_error)
        } else {
            self.inner.fs().create_dir(path).map_err(sdk_error)
        }
    }

    #[wasm_bindgen(js_name = readDir)]
    pub fn read_dir(&self, path: String) -> Result<JsValue, JsValue> {
        let entries: Vec<JsDirEntry> = self
            .inner
            .fs()
            .read_dir(path)
            .map_err(sdk_error)?
            .into_iter()
            .map(|entry| {
                let (kind, size) = stat_parts(&entry.metadata);
                JsDirEntry {
                    name: entry.name,
                    kind,
                    size,
                }
            })
            .collect();
        serde_wasm_bindgen::to_value(&entries).map_err(js_error)
    }

    pub fn stat(&self, path: String) -> Result<JsValue, JsValue> {
        let metadata = self.inner.fs().stat(path).map_err(sdk_error)?;
        let (kind, size) = stat_parts(&metadata);
        serde_wasm_bindgen::to_value(&JsFileStat { kind, size }).map_err(js_error)
    }

    pub fn remove(&self, path: String, recursive: bool) -> Result<(), JsValue> {
        self.inner.fs().remove(path, recursive).map_err(sdk_error)
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), JsValue> {
        self.inner.fs().rename(from, to).await.map_err(sdk_error)
    }

    /// Wait until a guest TCP listener accepts connections on `port`.
    #[wasm_bindgen(js_name = waitForPort)]
    pub async fn wait_for_port(&self, port: f64, timeout_ms: f64) -> Result<(), JsValue> {
        let port = validate_integer("port", port, 1, u64::from(u16::MAX))? as u16;
        let timeout = validate_duration("timeoutMs", timeout_ms)?;
        self.inner
            .ports()
            .wait(port, timeout)
            .await
            .map_err(sdk_error)
    }

    /// Whether a browser HTTP ingress listener exists on `port`.
    #[wasm_bindgen(js_name = isHttpPortListening)]
    pub fn is_http_port_listening(&self, port: f64) -> Result<bool, JsValue> {
        let port = validate_integer("port", port, 1, u64::from(u16::MAX))? as u16;
        let handler = self.browser_http.as_ref().ok_or_else(|| {
            custom_error(
                "CAPABILITY_UNAVAILABLE",
                "the sandbox was not created with browser HTTP networking",
            )
        })?;
        Ok(handler.has_listener(port))
    }

    /// Browser HTTP ingress ports currently owned by guest listeners.
    #[wasm_bindgen(js_name = httpListeningPorts)]
    pub fn http_listening_ports(&self) -> Result<Option<Vec<u16>>, JsValue> {
        let handler = self.browser_http.as_ref().ok_or_else(|| {
            custom_error(
                "CAPABILITY_UNAVAILABLE",
                "the sandbox was not created with browser HTTP networking",
            )
        })?;
        Ok(handler.listening_ports())
    }

    /// Forward one structured HTTP request into a guest TCP listener.
    #[wasm_bindgen(js_name = handleHttpRequest)]
    pub async fn handle_http_request(
        &self,
        port: f64,
        method: String,
        path: String,
        headers: JsValue,
        body: Uint8Array,
    ) -> Result<JsHttpResponse, JsValue> {
        let port = validate_integer("port", port, 1, u64::from(u16::MAX))? as u16;
        let handler = self.browser_http.as_ref().ok_or_else(|| {
            custom_error(
                "CAPABILITY_UNAVAILABLE",
                "the sandbox was not created with browser HTTP networking",
            )
        })?;
        let headers: Vec<(String, String)> =
            serde_wasm_bindgen::from_value(headers).map_err(js_error)?;
        let mut request = HttpRequest::builder()
            .method(method.as_str())
            .uri(path.as_str());
        let request_headers = request
            .headers_mut()
            .ok_or_else(|| custom_error("INVALID_ARGUMENT", "failed to construct HTTP request"))?;
        for (name, value) in headers {
            let name = http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                custom_error("INVALID_ARGUMENT", &format!("invalid HTTP header `{name}`"))
            })?;
            let value = http::HeaderValue::from_str(&value).map_err(|_| {
                custom_error(
                    "INVALID_ARGUMENT",
                    &format!("invalid value for HTTP header `{name}`"),
                )
            })?;
            request_headers.append(name, value);
        }
        if !request_headers.contains_key(HOST) {
            request_headers.insert(HOST, http::HeaderValue::from_static("localhost"));
        }
        let response = handler
            .handle(
                request
                    .body(Bytes::from(body.to_vec()))
                    .map_err(|error| custom_error("INVALID_ARGUMENT", &error.to_string()))?,
                port,
            )
            .await
            .map_err(|error| {
                custom_error(
                    "EXECUTION_ERROR",
                    &format!("guest HTTP request failed: {error}"),
                )
            })?;
        Ok(JsHttpResponse::new(response))
    }

    pub async fn close(&self) -> Result<(), JsValue> {
        self.inner.close().await.map_err(sdk_error)
    }
}

#[wasm_bindgen(js_name = HttpResponseCore)]
pub struct JsHttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl JsHttpResponse {
    fn new(response: http::Response<Bytes>) -> Self {
        let (parts, body) = response.into_parts();
        Self {
            status: parts.status.as_u16(),
            status_text: parts
                .status
                .canonical_reason()
                .unwrap_or_default()
                .to_owned(),
            headers: parts
                .headers
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_owned(), value.to_owned()))
                })
                .collect(),
            body: body.to_vec(),
        }
    }
}

#[wasm_bindgen(js_class = HttpResponseCore)]
impl JsHttpResponse {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[wasm_bindgen(getter, js_name = statusText)]
    pub fn status_text(&self) -> String {
        self.status_text.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn headers(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.headers).map_err(js_error)
    }

    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Uint8Array {
        Uint8Array::from(self.body.as_slice())
    }
}

#[wasm_bindgen(js_name = CommandCore)]
pub struct JsCommand {
    inner: Option<Command>,
}

#[wasm_bindgen(js_class = CommandCore)]
impl JsCommand {
    pub fn args(&mut self, args: Vec<String>) -> Result<(), JsValue> {
        self.inner_mut()?.args(args);
        Ok(())
    }

    pub fn env(&mut self, key: String, value: String) -> Result<(), JsValue> {
        self.inner_mut()?.env(key, value);
        Ok(())
    }

    #[wasm_bindgen(js_name = currentDir)]
    pub fn current_dir(&mut self, path: String) -> Result<(), JsValue> {
        self.inner_mut()?.current_dir(path);
        Ok(())
    }

    pub fn input(&mut self, bytes: Uint8Array) -> Result<(), JsValue> {
        self.inner_mut()?.input(bytes.to_vec());
        Ok(())
    }

    #[wasm_bindgen(js_name = outputBytes)]
    pub fn output_bytes(&mut self, bytes: f64) -> Result<(), JsValue> {
        let bytes = validate_usize("outputBytes", bytes, 0)?;
        self.inner_mut()?.output_bytes(bytes);
        Ok(())
    }

    #[wasm_bindgen(js_name = timeoutMs)]
    pub fn timeout_ms(&mut self, milliseconds: f64) -> Result<(), JsValue> {
        let timeout = validate_duration("timeoutMs", milliseconds)?;
        self.inner_mut()?.timeout(timeout);
        Ok(())
    }

    /// Attach an interactive terminal with the given character dimensions.
    pub fn terminal(&mut self, columns: f64, rows: f64) -> Result<(), JsValue> {
        let columns = validate_integer("terminal.columns", columns, 1, u64::from(u32::MAX))?;
        let rows = validate_integer("terminal.rows", rows, 1, u64::from(u32::MAX))?;
        self.inner_mut()?
            .terminal(TerminalOptions::new(columns as u32, rows as u32));
        Ok(())
    }

    /// Live stdin mode for `spawn()`: `"pipe"` or `"closed"`.
    #[wasm_bindgen(js_name = stdinMode)]
    pub fn stdin_mode(&mut self, mode: String) -> Result<(), JsValue> {
        let stdio = match mode.as_str() {
            "pipe" => Stdio::Piped,
            "closed" => Stdio::Null,
            other => return Err(invalid_stdio_mode(other)),
        };
        self.inner_mut()?.stdin(stdio);
        Ok(())
    }

    /// Live stdout mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
    #[wasm_bindgen(js_name = stdoutMode)]
    pub fn stdout_mode(&mut self, mode: String) -> Result<(), JsValue> {
        let stdio = parse_output_mode(&mode)?;
        self.inner_mut()?.stdout(stdio);
        Ok(())
    }

    /// Live stderr mode for `spawn()`: `"pipe"`, `"capture"`, or `"discard"`.
    #[wasm_bindgen(js_name = stderrMode)]
    pub fn stderr_mode(&mut self, mode: String) -> Result<(), JsValue> {
        let stdio = parse_output_mode(&mode)?;
        self.inner_mut()?.stderr(stdio);
        Ok(())
    }

    pub async fn run(mut self) -> Result<JsOutput, JsValue> {
        self.take()?
            .output()
            .await
            .map(|inner| JsOutput { inner })
            .map_err(sdk_error)
    }

    pub async fn spawn(mut self) -> Result<JsProcess, JsValue> {
        let mut process = self.take()?.spawn().await.map_err(sdk_error)?;
        let handle = process.handle();
        let stdin = process.take_stdin();
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        Ok(JsProcess {
            id: process.id(),
            handle,
            process: Mutex::new(process),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(stdout),
            stderr: Mutex::new(stderr),
        })
    }
}

fn parse_output_mode(mode: &str) -> Result<Stdio, JsValue> {
    match mode {
        "pipe" => Ok(Stdio::Piped),
        "capture" => Ok(Stdio::Capture),
        "discard" => Ok(Stdio::Null),
        other => Err(invalid_stdio_mode(other)),
    }
}

fn invalid_stdio_mode(mode: &str) -> JsValue {
    custom_error("TARGET_ERROR", &format!("unsupported stdio mode `{mode}`"))
}

impl JsCommand {
    fn inner_mut(&mut self) -> Result<&mut Command, JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| custom_error("TARGET_ERROR", "command was already consumed"))
    }

    fn take(&mut self) -> Result<Command, JsValue> {
        self.inner
            .take()
            .ok_or_else(|| custom_error("TARGET_ERROR", "command was already consumed"))
    }
}

#[wasm_bindgen(js_name = OutputCore)]
pub struct JsOutput {
    inner: Output,
}

#[wasm_bindgen(js_class = OutputCore)]
impl JsOutput {
    #[wasm_bindgen(getter, js_name = exitCode)]
    pub fn exit_code(&self) -> i32 {
        self.inner.status.code()
    }

    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.inner.ok()
    }

    /// Why the process stopped: `"exited"`, `"terminated"`, or `"timeout"`.
    #[wasm_bindgen(getter)]
    pub fn reason(&self) -> String {
        self.inner.reason.as_str().to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn stdout(&self) -> Uint8Array {
        Uint8Array::from(self.inner.stdout.bytes())
    }

    #[wasm_bindgen(getter)]
    pub fn stderr(&self) -> Uint8Array {
        Uint8Array::from(self.inner.stderr.bytes())
    }

    #[wasm_bindgen(getter, js_name = stdoutTruncated)]
    pub fn stdout_truncated(&self) -> bool {
        self.inner.stdout.truncated()
    }

    #[wasm_bindgen(getter, js_name = stderrTruncated)]
    pub fn stderr_truncated(&self) -> bool {
        self.inner.stderr.truncated()
    }
}

#[wasm_bindgen(js_name = ProcessCore)]
pub struct JsProcess {
    id: u32,
    /// Signals never contend with a concurrent `wait()`: they go through the
    /// lock-free handle, not the mutex that `wait()` holds.
    handle: ProcessHandle,
    process: Mutex<Process>,
    stdin: Mutex<Option<ProcessStdin>>,
    stdout: Mutex<Option<ProcessStdout>>,
    stderr: Mutex<Option<ProcessStderr>>,
}

#[wasm_bindgen(js_class = ProcessCore)]
impl JsProcess {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    #[wasm_bindgen(js_name = writeStdin)]
    pub async fn write_stdin(&self, bytes: Uint8Array) -> Result<(), JsValue> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .as_mut()
            .ok_or_else(|| custom_error("TARGET_ERROR", "stdin is closed"))?
            .write_all(&bytes.to_vec())
            .await
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = closeStdin)]
    pub async fn close_stdin(&self) -> Result<(), JsValue> {
        let mut stdin = self.stdin.lock().await.take();
        if let Some(stdin) = stdin.as_mut() {
            stdin.shutdown().await.map_err(js_error)?;
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = readStdout)]
    pub async fn read_stdout(&self, max_bytes: f64) -> Result<JsValue, JsValue> {
        let max_bytes = validate_usize("maxBytes", max_bytes, 1)?;
        read_stream(&self.stdout, max_bytes).await
    }

    #[wasm_bindgen(js_name = readStderr)]
    pub async fn read_stderr(&self, max_bytes: f64) -> Result<JsValue, JsValue> {
        let max_bytes = validate_usize("maxBytes", max_bytes, 1)?;
        read_stream(&self.stderr, max_bytes).await
    }

    pub async fn wait(&self) -> Result<JsOutput, JsValue> {
        self.process
            .lock()
            .await
            .wait()
            .await
            .map(|inner| JsOutput { inner })
            .map_err(sdk_error)
    }

    pub async fn terminate(&self, grace_ms: f64) -> Result<(), JsValue> {
        let grace = validate_duration("gracePeriodMs", grace_ms)?;
        self.handle.terminate(grace).await;
        Ok(())
    }

    pub fn kill(&self) {
        self.handle.kill();
    }

    #[wasm_bindgen(js_name = resizeTerminal)]
    pub fn resize_terminal(&self, columns: f64, rows: f64) -> Result<(), JsValue> {
        let columns = validate_integer("terminal.columns", columns, 1, u64::from(u32::MAX))?;
        let rows = validate_integer("terminal.rows", rows, 1, u64::from(u32::MAX))?;
        self.handle
            .resize_terminal(columns as u32, rows as u32)
            .map_err(sdk_error)
    }
}

async fn read_stream<S>(stream: &Mutex<Option<S>>, max_bytes: usize) -> Result<JsValue, JsValue>
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut stream = stream.lock().await;
    let Some(reader) = stream.as_mut() else {
        return Ok(JsValue::NULL);
    };
    let mut bytes = vec![0_u8; max_bytes.max(1)];
    let length = reader.read(&mut bytes).await.map_err(js_error)?;
    if length == 0 {
        stream.take();
        return Ok(JsValue::NULL);
    }
    bytes.truncate(length);
    Ok(Uint8Array::from(bytes.as_slice()).into())
}

/// Convert an SDK error into a JavaScript error carrying its provisional code.
fn sdk_error(error: wasmer_sdk::Error) -> JsValue {
    custom_error(error.code(), &error.to_string())
}

/// A JavaScript error with the SDK name and a machine-readable code.
fn custom_error(code: &str, message: &str) -> JsValue {
    let error = js_sys::Error::new(message);
    error.set_name("WasmerError");
    let _ = js_sys::Reflect::set(&error, &JsValue::from_str("code"), &JsValue::from_str(code));
    error.into()
}

/// Fallback for non-SDK failures (stream I/O, serialization).
fn js_error(error: impl std::fmt::Display) -> JsValue {
    custom_error("TARGET_ERROR", &error.to_string())
}

fn validate_duration(name: &str, value: f64) -> Result<Duration, JsValue> {
    validate_integer(name, value, 0, MAX_SAFE_INTEGER).map(Duration::from_millis)
}

fn validate_usize(name: &str, value: f64, minimum: u64) -> Result<usize, JsValue> {
    let value = validate_integer(name, value, minimum, MAX_WASM32_SIZE)?;
    usize::try_from(value).map_err(|_| invalid_numeric_argument(name, minimum, MAX_WASM32_SIZE))
}

fn validate_integer(name: &str, value: f64, minimum: u64, maximum: u64) -> Result<u64, JsValue> {
    #[allow(clippy::cast_precision_loss)]
    let minimum_f64 = minimum as f64;
    #[allow(clippy::cast_precision_loss)]
    let maximum_f64 = maximum as f64;
    if !value.is_finite() || value.fract() != 0.0 || value < minimum_f64 || value > maximum_f64 {
        return Err(invalid_numeric_argument(name, minimum, maximum));
    }
    Ok(value as u64)
}

fn invalid_numeric_argument(name: &str, minimum: u64, maximum: u64) -> JsValue {
    custom_error(
        "INVALID_ARGUMENT",
        &format!("`{name}` must be an integer between {minimum} and {maximum}, inclusive"),
    )
}
