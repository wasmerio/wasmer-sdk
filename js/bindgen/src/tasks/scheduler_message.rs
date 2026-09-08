use std::marker::PhantomData;

use derivative::Derivative;
use wasm_bindgen::JsValue;

use crate::{
    tasks::{
        AsyncTask, BlockingTask,
        interop::{Deserializer, Serializer},
        task_wasm::SpawnWasm,
    },
    worker_utils::Error,
};

/// Messages sent from the [`crate::tasks::ThreadPool`] handle to the
/// `Scheduler`.
#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum SchedulerMessage {
    /// Close the scheduler.
    Close {
        #[derivative(Debug(format_with = "crate::worker_utils::hidden"))]
        completion: Option<tokio::sync::oneshot::Sender<()>>,
        /// Wait for active WebAssembly tasks to reach their worker-idle
        /// boundary before terminating the workers.
        drain: bool,
    },
    /// Run a promise on a worker thread.
    SpawnAsync(#[derivative(Debug(format_with = "crate::worker_utils::hidden"))] AsyncTask),
    /// Run a blocking operation on a worker thread.
    SpawnBlocking(#[derivative(Debug(format_with = "crate::worker_utils::hidden"))] BlockingTask),
    /// A message sent from a worker thread.
    /// Mark a worker as idle.
    WorkerIdle { worker_id: u32 },
    /// Mark a worker as busy.
    WorkerBusy { worker_id: u32 },
    /// Terminate the browser worker executing a WASIX thread.
    TerminateWasmThread { pid: u32, tid: u32 },
    /// Publish a nested WebAssembly object to the other browser workers.
    CapiShare {
        source_worker_id: u32,
        registry_id: u32,
        handle: i32,
        value: JsValue,
    },
    /// Ask the scheduler to deliver a previously published host value to one
    /// specific worker. This is used when the destination thread was already
    /// running when the value was shared.
    CapiRequest {
        requesting_worker_id: u32,
        registry_id: u32,
        handle: i32,
    },
    /// Release a nested WebAssembly object which has not been attached to a
    /// destination task yet.
    CapiDelete {
        source_worker_id: u32,
        registry_id: u32,
        handle: i32,
    },
    /// A scheduler message emitted by a worker. Keeping its source ID lets
    /// nested WebAssembly transfers and the task consuming them stay together.
    FromWorker {
        source_worker_id: u32,
        message: Box<SchedulerMessage>,
    },
    /// Run a WASIX task with backend-managed shared handles.
    SpawnWasm(SpawnWasm),
    #[doc(hidden)]
    #[allow(dead_code)]
    Markers {
        /// Keep worker-local C API messages from crossing Rust threads.
        not_send: PhantomData<*const ()>,
        /// Mark this variant as unreachable.
        uninhabited: std::convert::Infallible,
    },
}

impl SchedulerMessage {
    pub(crate) unsafe fn try_from_js(value: JsValue) -> Result<Self, Error> {
        let de = unsafe { Deserializer::new(value)? };

        match de.ty()?.as_str() {
            consts::TYPE_CLOSE => Ok(SchedulerMessage::Close {
                completion: None,
                drain: false,
            }),
            consts::TYPE_SPAWN_ASYNC => {
                let task = unsafe { de.boxed(consts::PTR)? };
                Ok(SchedulerMessage::SpawnAsync(task))
            }
            consts::TYPE_SPAWN_BLOCKING => {
                let task = unsafe { de.boxed(consts::PTR)? };
                Ok(SchedulerMessage::SpawnBlocking(task))
            }
            consts::TYPE_WORKER_IDLE => {
                let worker_id = de.serde(consts::WORKER_ID)?;
                Ok(SchedulerMessage::WorkerIdle { worker_id })
            }
            consts::TYPE_WORKER_BUSY => {
                let worker_id = de.serde(consts::WORKER_ID)?;
                Ok(SchedulerMessage::WorkerBusy { worker_id })
            }
            consts::TYPE_TERMINATE_WASM_THREAD => {
                let pid = de.serde(consts::PID)?;
                let tid = de.serde(consts::TID)?;
                Ok(SchedulerMessage::TerminateWasmThread { pid, tid })
            }
            consts::TYPE_SPAWN_WASM => Ok(SchedulerMessage::SpawnWasm(unsafe {
                de.boxed(consts::PTR)?
            })),
            other => {
                tracing::warn!(r#type = other, "Unknown message type");
                Err(anyhow::anyhow!("Unknown message type, \"{other}\"").into())
            }
        }
    }

    pub(crate) fn into_js(self) -> Result<JsValue, Error> {
        match self {
            SchedulerMessage::Close {
                completion: None, ..
            } => Serializer::new(consts::TYPE_CLOSE).finish(),
            SchedulerMessage::Close {
                completion: Some(_),
                ..
            } => Err(
                anyhow::anyhow!("acknowledged close messages are local to the scheduler").into(),
            ),
            SchedulerMessage::SpawnAsync(task) => Serializer::new(consts::TYPE_SPAWN_ASYNC)
                .boxed(consts::PTR, task)
                .finish(),
            SchedulerMessage::SpawnBlocking(task) => Serializer::new(consts::TYPE_SPAWN_BLOCKING)
                .boxed(consts::PTR, task)
                .finish(),
            SchedulerMessage::WorkerIdle { worker_id } => Serializer::new(consts::TYPE_WORKER_IDLE)
                .set(consts::WORKER_ID, worker_id)
                .finish(),
            SchedulerMessage::WorkerBusy { worker_id } => Serializer::new(consts::TYPE_WORKER_BUSY)
                .set(consts::WORKER_ID, worker_id)
                .finish(),
            SchedulerMessage::TerminateWasmThread { pid, tid } => {
                Serializer::new(consts::TYPE_TERMINATE_WASM_THREAD)
                    .set(consts::PID, pid)
                    .set(consts::TID, tid)
                    .finish()
            }
            SchedulerMessage::CapiShare { .. }
            | SchedulerMessage::CapiRequest { .. }
            | SchedulerMessage::CapiDelete { .. } => {
                Err(anyhow::anyhow!("C API messages are local to the scheduler").into())
            }
            SchedulerMessage::FromWorker { .. } => {
                Err(anyhow::anyhow!("worker-origin messages are local to the scheduler").into())
            }
            SchedulerMessage::SpawnWasm(task) => Serializer::new(consts::TYPE_SPAWN_WASM)
                .boxed(consts::PTR, task)
                .finish(),
            SchedulerMessage::Markers { uninhabited, .. } => match uninhabited {},
        }
    }
}

mod consts {
    pub const TYPE_CLOSE: &str = "close";
    pub const TYPE_SPAWN_ASYNC: &str = "spawn-async";
    pub const TYPE_SPAWN_BLOCKING: &str = "spawn-blocking";
    pub const TYPE_WORKER_IDLE: &str = "worker-idle";
    pub const TYPE_WORKER_BUSY: &str = "worker-busy";
    pub const TYPE_TERMINATE_WASM_THREAD: &str = "terminate-wasm-thread";
    pub const TYPE_SPAWN_WASM: &str = "spawn-wasm";
    pub const PTR: &str = "ptr";
    pub const WORKER_ID: &str = "worker-id";
    pub const PID: &str = "pid";
    pub const TID: &str = "tid";
}
