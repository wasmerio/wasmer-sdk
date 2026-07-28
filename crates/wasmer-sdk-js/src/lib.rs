#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::missing_errors_doc,
    clippy::missing_fields_in_debug,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value,
    clippy::type_complexity
)]

mod node_network;
mod task_manager;
mod tasks;
mod worker_utils;

use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use js_sys::Uint8Array;
use node_network::{NodeNetworkBridge, NodeNetworking};
use once_cell::sync::Lazy;
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use wasm_bindgen::prelude::*;
use wasmer_sdk::{
    Command, NetworkPolicy, Output, Package, PackageSource, Process, ProcessStderr, ProcessStdin,
    ProcessStdout, Sandbox, SandboxBuilder, Stdio, Wasmer, WasmerConfig,
};
use wasmer_wasix::PluggableRuntime;

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
    output_bytes: Option<usize>,
}

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
    ) -> Result<Self, JsValue> {
        let options: ClientOptions = if options.is_null() || options.is_undefined() {
            ClientOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options).map_err(js_error)?
        };
        let tasks = Arc::new(tasks::ThreadPool::new());
        let mut runtime = PluggableRuntime::new(Arc::clone(&tasks) as Arc<_>);
        if let Some(bridge) = node_network {
            runtime.set_networking_implementation(NodeNetworking::new(bridge));
        }
        let config = WasmerConfig {
            output_bytes: options.output_bytes.unwrap_or(16 * 1024 * 1024),
            ..WasmerConfig::default()
        };
        let inner = Wasmer::from_js_runtime(&config, runtime).map_err(js_error)?;
        Ok(Self { inner, tasks })
    }

    #[wasm_bindgen(js_name = loadPackage)]
    pub async fn load_package(&self, specifier: String) -> Result<JsPackage, JsValue> {
        self.inner
            .load_package(specifier)
            .await
            .map(|inner| JsPackage { inner })
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = loadPackageBytes)]
    pub async fn load_package_bytes(&self, bytes: Uint8Array) -> Result<JsPackage, JsValue> {
        self.inner
            .load_package(PackageSource::webc(bytes.to_vec()))
            .await
            .map(|inner| JsPackage { inner })
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = sandbox)]
    pub fn sandbox(&self) -> JsSandboxBuilder {
        JsSandboxBuilder {
            inner: Some(self.inner.sandbox()),
        }
    }

    pub async fn shutdown(&self) -> Result<(), JsValue> {
        self.inner.shutdown().await.map_err(js_error)?;
        self.tasks.close();
        wasm_bindgen_futures::JsFuture::from(worker_utils::GlobalScope::current().sleep(0)).await?;
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
}

#[wasm_bindgen(js_name = SandboxBuilderCore)]
pub struct JsSandboxBuilder {
    inner: Option<SandboxBuilder>,
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

    pub fn network(&mut self, enabled: bool) -> Result<(), JsValue> {
        let policy = if enabled {
            NetworkPolicy::Host
        } else {
            NetworkPolicy::Disabled
        };
        let builder = self.take()?.network(policy);
        self.inner = Some(builder);
        Ok(())
    }

    pub async fn start(mut self) -> Result<JsSandbox, JsValue> {
        self.take()?
            .start()
            .await
            .map(|inner| JsSandbox { inner })
            .map_err(js_error)
    }
}

impl JsSandboxBuilder {
    fn take(&mut self) -> Result<SandboxBuilder, JsValue> {
        self.inner
            .take()
            .ok_or_else(|| js_sys::Error::new("sandbox builder was already consumed").into())
    }
}

#[wasm_bindgen(js_name = SandboxCore)]
pub struct JsSandbox {
    inner: Sandbox,
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

    #[wasm_bindgen(js_name = installPackage)]
    pub async fn install_package(&self, specifier: String) -> Result<JsPackage, JsValue> {
        self.inner
            .install_package(specifier)
            .await
            .map(|inner| JsPackage { inner })
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = installPackageBytes)]
    pub async fn install_package_bytes(&self, bytes: Uint8Array) -> Result<JsPackage, JsValue> {
        self.inner
            .install_package(PackageSource::webc(bytes.to_vec()))
            .await
            .map(|inner| JsPackage { inner })
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = writeFile)]
    pub async fn write_file(&self, path: String, bytes: Uint8Array) -> Result<(), JsValue> {
        self.inner
            .fs()
            .write(path, bytes.to_vec())
            .await
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = readFile)]
    pub async fn read_file(&self, path: String) -> Result<Uint8Array, JsValue> {
        self.inner
            .fs()
            .read(path)
            .await
            .map(|bytes| Uint8Array::from(bytes.as_slice()))
            .map_err(js_error)
    }

    pub async fn close(&self) -> Result<(), JsValue> {
        self.inner.close().await.map_err(js_error)
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
    pub fn output_bytes(&mut self, bytes: usize) -> Result<(), JsValue> {
        self.inner_mut()?.output_bytes(bytes);
        Ok(())
    }

    pub async fn run(mut self) -> Result<JsOutput, JsValue> {
        self.take()?
            .output()
            .await
            .map(|inner| JsOutput { inner })
            .map_err(js_error)
    }

    pub async fn spawn(mut self) -> Result<JsProcess, JsValue> {
        let command = self.inner_mut()?;
        command
            .stdin(Stdio::Piped)
            .stdout(Stdio::Piped)
            .stderr(Stdio::Piped);
        let mut process = self.take()?.spawn().await.map_err(js_error)?;
        let stdin = process.take_stdin();
        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        Ok(JsProcess {
            id: process.id(),
            process: Arc::new(Mutex::new(process)),
            stdin: Arc::new(Mutex::new(stdin)),
            stdout: Arc::new(Mutex::new(stdout)),
            stderr: Arc::new(Mutex::new(stderr)),
        })
    }
}

impl JsCommand {
    fn inner_mut(&mut self) -> Result<&mut Command, JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| js_sys::Error::new("command was already consumed").into())
    }

    fn take(&mut self) -> Result<Command, JsValue> {
        self.inner
            .take()
            .ok_or_else(|| js_sys::Error::new("command was already consumed").into())
    }
}

#[wasm_bindgen(js_name = OutputCore)]
pub struct JsOutput {
    inner: Output,
}

#[wasm_bindgen(js_class = OutputCore)]
impl JsOutput {
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> i32 {
        self.inner.status.code()
    }

    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.inner.status.success()
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
    process: Arc<Mutex<Process>>,
    stdin: Arc<Mutex<Option<ProcessStdin>>>,
    stdout: Arc<Mutex<Option<ProcessStdout>>>,
    stderr: Arc<Mutex<Option<ProcessStderr>>>,
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
            .ok_or_else(|| js_sys::Error::new("stdin is closed"))?
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
    pub async fn read_stdout(&self, max_bytes: usize) -> Result<JsValue, JsValue> {
        read_stream(&self.stdout, max_bytes).await
    }

    #[wasm_bindgen(js_name = readStderr)]
    pub async fn read_stderr(&self, max_bytes: usize) -> Result<JsValue, JsValue> {
        read_stream(&self.stderr, max_bytes).await
    }

    pub async fn wait(&self) -> Result<JsOutput, JsValue> {
        self.process
            .lock()
            .await
            .wait()
            .await
            .map(|inner| JsOutput { inner })
            .map_err(js_error)
    }

    pub async fn terminate(&self, grace_ms: u32) -> Result<(), JsValue> {
        self.process
            .lock()
            .await
            .terminate(Duration::from_millis(u64::from(grace_ms)))
            .await
            .map_err(js_error)
    }

    pub async fn kill(&self) -> Result<(), JsValue> {
        self.process.lock().await.kill().map_err(js_error)
    }
}

async fn read_stream<S>(
    stream: &Arc<Mutex<Option<S>>>,
    max_bytes: usize,
) -> Result<JsValue, JsValue>
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

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}
