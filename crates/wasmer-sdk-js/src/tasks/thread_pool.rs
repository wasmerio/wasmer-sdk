use std::{fmt::Debug, future::Future, pin::Pin};

use futures::future::LocalBoxFuture;
use instant::Duration;
use wasm_bindgen_futures::JsFuture;
use wasmer_wasix::{VirtualTaskManager, WasiThreadError, runtime::task_manager::TaskWasm};

use crate::{
    tasks::{Scheduler, SchedulerMessage},
    worker_utils::GlobalScope,
};

/// A handle to a threadpool backed by Web Workers. Shared via `Arc`; closing
/// happens on drop or through [`ThreadPool::close`].
#[derive(Debug)]
pub struct ThreadPool {
    scheduler: Scheduler,
}

const CROSS_ORIGIN_WARNING: &str = r#"You can only run packages from "Cross-Origin Isolated" websites. For more details, check out https://docs.wasmer.io/javascript-sdk/explainers/troubleshooting#sharedarraybuffer-and-cross-origin-isolation"#;

impl ThreadPool {
    pub fn new() -> Self {
        if let Some(cross_origin_isolated) =
            crate::worker_utils::GlobalScope::current().cross_origin_isolated()
        {
            // Browsers require cross-origin isolation for SharedArrayBuffer;
            // the Node entrypoint reports `None` here and skips the warning.
            web_sys::console::assert_with_condition_and_data_1(
                cross_origin_isolated,
                &wasm_bindgen::JsValue::from_str(CROSS_ORIGIN_WARNING),
            );
        }

        let sender = Scheduler::spawn();
        ThreadPool { scheduler: sender }
    }

    /// Run an `async` function to completion on the threadpool.
    pub fn spawn(
        &self,
        task: Box<dyn FnOnce() -> LocalBoxFuture<'static, ()> + Send>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnAsync(task))
    }

    /// Send a message to the scheduler.
    ///
    /// A failure means the pool is shut down. It must surface as an ordinary
    /// error: a panic here would abort the whole wasm module.
    pub(crate) fn send(&self, msg: SchedulerMessage) -> Result<(), WasiThreadError> {
        self.scheduler.send(msg).map_err(|error| {
            WasiThreadError::InitFailed(std::sync::Arc::new(anyhow::anyhow!(
                "the thread pool is shut down: {error}"
            )))
        })
    }

    pub fn close(&self) {
        self.scheduler.close();
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        // `ThreadPool` is intentionally not `Clone`: the pool is shared as
        // `Arc<ThreadPool>`, so this drop runs exactly once and may close the
        // scheduler. Without it, a client that never calls `shutdown()` would
        // leak the workers and keep a Node process alive forever.
        tracing::debug!("Terminating ThreadPool");
        self.scheduler.close();
    }
}

#[async_trait::async_trait]
impl VirtualTaskManager for ThreadPool {
    /// Invokes whenever a WASM thread goes idle. In some runtimes (like
    /// singlethreaded execution environments) they will need to do asynchronous
    /// work whenever the main thread goes idle and this is the place to hook
    /// for that.
    fn sleep_now(
        &self,
        time: Duration,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + Sync + 'static>> {
        let (tx, rx) = tokio::sync::oneshot::channel();

        let time = if time.as_millis() < i32::MAX as u128 {
            time.as_millis() as i32
        } else {
            i32::MAX
        };

        // Note: We can't use wasm_bindgen_futures::spawn_local() directly
        // because we might be invoked from inside a syscall. This causes a
        // deadlock because the syscall will block block until the future
        // resolves, but the JsFuture will never get a chance to mark itself as
        // resolved because the JavaScript VM is still blocked by the syscall.
        //
        // If the pool is already shut down, the sender drops immediately and
        // the returned future resolves at once instead of hanging.
        let _ = self.task_dedicated(Box::new(move || {
            wasm_bindgen_futures::spawn_local(async move {
                let global = GlobalScope::current();
                let _ = JsFuture::from(global.sleep(time)).await;
                let _ = tx.send(());
            })
        }));

        Box::pin(async move {
            let _ = rx.await;
        })
    }

    /// Starts an asynchronous task that will run on a shared worker pool
    /// This task must not block the execution or it could cause a deadlock
    fn task_shared(
        &self,
        task: Box<
            dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> + Send + 'static,
        >,
    ) -> Result<(), WasiThreadError> {
        self.spawn(Box::new(move || Box::pin(async move { task().await })))
    }

    /// Starts an asynchronous task will will run on a dedicated thread
    /// pulled from the worker pool that has a stateful thread local variable
    /// It is ok for this task to block execution and any async futures within its scope
    fn task_wasm(&self, task: TaskWasm) -> Result<(), WasiThreadError> {
        let msg = crate::tasks::task_wasm::to_scheduler_message(task)?;
        self.send(msg)
    }

    /// Starts an asynchronous task will will run on a dedicated thread
    /// pulled from the worker pool. It is ok for this task to block execution
    /// and any async futures within its scope
    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnBlocking(task))
    }

    /// Returns the amount of parallelism that is possible on this platform
    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        match crate::worker_utils::GlobalScope::current().hardware_concurrency() {
            Some(n) => Ok(n.get()),
            None => Err(WasiThreadError::Unsupported),
        }
    }

    fn spawn_with_module(
        &self,
        module: wasmer::Module,
        task: Box<dyn FnOnce(wasmer::Module) + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnWithModule { task, module })
    }
}
