use std::{fmt::Debug, future::Future, num::NonZeroUsize, pin::Pin};

use futures::future::LocalBoxFuture;
use instant::Duration;
use wasmer_wasix::{
    VirtualTaskManager, WasiProcessId, WasiThreadError, WasiThreadId,
    runtime::task_manager::TaskWasm,
};

use crate::{
    tasks::{Scheduler, SchedulerMessage},
    worker_utils::GlobalScope,
};

/// A handle to a threadpool backed by Web Workers. Shared via `Arc`; closing
/// happens on drop or through [`ThreadPool::close`].
#[derive(Debug)]
pub struct ThreadPool {
    scheduler: Scheduler,
    parallelism: Option<NonZeroUsize>,
}

const CROSS_ORIGIN_WARNING: &str = r#"You can only run packages from "Cross-Origin Isolated" websites. For more details, check out https://docs.wasmer.io/javascript-sdk/explainers/troubleshooting#sharedarraybuffer-and-cross-origin-isolation"#;

impl ThreadPool {
    pub fn new(parallelism: Option<NonZeroUsize>) -> Self {
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
        ThreadPool {
            scheduler: sender,
            parallelism,
        }
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

    pub async fn close_and_wait(&self) {
        self.scheduler.close_and_wait().await;
    }

    fn terminate_worker(
        &self,
        pid: WasiProcessId,
        tid: WasiThreadId,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::TerminateWasmThread {
            pid: pid.raw(),
            tid: tid.raw(),
        })
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
        // WASIX uses a zero timeout for non-blocking poll_oneoff calls. It is
        // not a timer: scheduling it through the browser would add a
        // main-worker-wake-worker round trip to every libuv NOWAIT poll. Edge
        // already performs an explicit JSPI host yield at its event-loop
        // boundary, so completing the non-blocking poll immediately preserves
        // both contracts.
        if time.is_zero() {
            return Box::pin(std::future::ready(()));
        }

        let (tx, rx) = tokio::sync::oneshot::channel();

        let millis = time.as_millis().max(1);
        let time = if millis < i32::MAX as u128 {
            millis as i32
        } else {
            i32::MAX
        };

        // This timer runs on a separate worker because a WASIX syscall may
        // synchronously block its calling worker. The guest now runs inside an
        // environment-owned JavaScript global, so this worker's host timer is
        // no longer exposed to guest mutation.
        let _ = self.task_dedicated(Box::new(move || {
            wasm_bindgen_futures::spawn_local(async move {
                let global = GlobalScope::current();
                let _ = wasm_bindgen_futures::JsFuture::from(global.sleep(time)).await;
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

    fn terminate_wasm_thread(
        &self,
        pid: WasiProcessId,
        tid: WasiThreadId,
    ) -> Result<(), WasiThreadError> {
        self.terminate_worker(pid, tid)
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
        if let Some(parallelism) = self.parallelism {
            return Ok(parallelism.get());
        }
        match GlobalScope::current().hardware_concurrency() {
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

#[cfg(test)]
mod tests {
    use futures::{FutureExt, channel::oneshot};
    use js_sys::Uint8Array;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    const TEST_WASM: &[u8] = &[
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03,
        0x02, 0x01, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d,
        0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, 0x0a,
        0x04, 0x01, 0x02, 0x00, 0x0b,
    ];

    #[wasm_bindgen_test]
    async fn transfer_module_to_worker() {
        let data = Uint8Array::from(TEST_WASM);
        let module: js_sys::WebAssembly::Module =
            JsFuture::from(js_sys::WebAssembly::compile(&data))
                .await
                .unwrap()
                .dyn_into()
                .unwrap();
        let module = wasmer::Module::from((module, bytes::Bytes::from_static(TEST_WASM)));
        let pool = ThreadPool::new(None);

        let (sender, receiver) = oneshot::channel();
        pool.spawn_with_module(
            module,
            Box::new(move |module| {
                sender.send(module.exports().count()).unwrap();
            }),
        )
        .unwrap();

        assert_eq!(receiver.await.unwrap(), 2);
        pool.close_and_wait().await;
    }

    #[wasm_bindgen_test]
    async fn spawned_tasks_can_communicate_with_the_main_thread() {
        let pool = ThreadPool::new(None);
        let (sender, receiver) = oneshot::channel();

        pool.task_shared(Box::new(move || {
            Box::pin(async move {
                sender.send(42_u32).unwrap();
            })
        }))
        .unwrap();

        assert_eq!(receiver.await.unwrap(), 42);
        pool.close_and_wait().await;
    }

    /// Regression test for wasmer-js#355: a worker must be marked busy before
    /// another interdependent blocking task can be assigned to it.
    #[wasm_bindgen_test]
    async fn spawn_interdependent_blocking_tasks_out_of_order() {
        let (sender_1, receiver_1) = oneshot::channel();
        let (sender_2, mut receiver_2) = oneshot::channel();
        let pool = ThreadPool::new(None);

        let first_task = Box::new(move || sender_1.send(()).unwrap());
        let second_task = Box::new(move || {
            futures::executor::block_on(receiver_1).unwrap();
            sender_2.send(()).unwrap();
        });

        pool.task_dedicated(second_task).unwrap();
        pool.task_dedicated(first_task).unwrap();

        let timeout = JsFuture::from(GlobalScope::current().sleep(1000));
        futures::select! {
            _ = timeout.fuse() => panic!("interdependent blocking tasks deadlocked"),
            _ = receiver_2 => {}
        }
        pool.close_and_wait().await;
    }
}
