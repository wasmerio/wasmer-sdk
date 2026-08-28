use std::cell::Cell;

use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

use crate::tasks::{AsyncJob, BlockingJob, Notification, PostMessagePayload, WorkerMessage};

/// The Rust state for a worker in the threadpool.
#[wasm_bindgen(skip_typescript)]
#[derive(Debug)]
pub struct ThreadPoolWorker {
    id: u32,
    active_blocking_jobs: Cell<u32>,
}

impl ThreadPoolWorker {
    fn busy(&self) -> impl Drop + '_ {
        struct BusyGuard<'a>(&'a ThreadPoolWorker);

        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                let worker = self.0;
                let active = worker.active_blocking_jobs.get();
                let remaining = active
                    .checked_sub(1)
                    .expect("blocking job count should never underflow");
                worker.active_blocking_jobs.set(remaining);

                if remaining == 0 {
                    let _ = WorkerMessage::MarkIdle.emit();
                }
            }
        }

        let active = self.active_blocking_jobs.get();
        self.active_blocking_jobs.set(
            active
                .checked_add(1)
                .expect("too many active blocking jobs"),
        );

        if active == 0 {
            let _ = WorkerMessage::MarkBusy.emit();
        }

        BusyGuard(self)
    }

    #[tracing::instrument(level = "debug", skip_all, fields(worker.id = self.id))]
    pub async fn handle(&self, msg: JsValue) -> Result<(), crate::worker_utils::Error> {
        // Safety: The message was created using PostMessagePayload::to_js()
        let msg = unsafe { PostMessagePayload::try_from_js(msg)? };

        tracing::trace!(?msg, "Handling a message");

        match msg {
            PostMessagePayload::Async(async_job) => self.execute_async(async_job).await,
            PostMessagePayload::Blocking(blocking) => self.execute_blocking(blocking).await,
            PostMessagePayload::Notification(Notification::CacheModule { hash, module: _ }) => {
                tracing::warn!(%hash, "TODO Caching module");

                Ok(())
            }
        }
    }

    async fn execute_async(&self, job: AsyncJob) -> Result<(), crate::worker_utils::Error> {
        match job {
            AsyncJob::Thunk(thunk) => {
                thunk().await;
            }
        }

        Ok(())
    }

    async fn execute_blocking(&self, job: BlockingJob) -> Result<(), crate::worker_utils::Error> {
        match job {
            BlockingJob::Thunk(thunk) => {
                let _guard = self.busy();
                thunk();
            }
            BlockingJob::SpawnWithModule { module, task } => {
                let _guard = self.busy();
                task(module.into());
            }
            BlockingJob::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            } => {
                let task = spawn_wasm.begin().await;
                let _guard = self.busy();
                task.execute(module, memory.into()).await?;
            }
        }

        Ok(())
    }
}

#[wasm_bindgen]
impl ThreadPoolWorker {
    #[wasm_bindgen(constructor)]
    pub fn new(id: u32) -> ThreadPoolWorker {
        ThreadPoolWorker {
            id,
            active_blocking_jobs: Cell::new(0),
        }
    }

    #[wasm_bindgen(js_name = "handle")]
    pub async fn js_handle(&self, msg: JsValue) -> Result<(), crate::worker_utils::Error> {
        self.handle(msg).await
    }
}
