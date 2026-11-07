//! Execute a WASIX task after the JS backend's objects have been transported.
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use crate::tasks::SchedulerMessage;
use anyhow::Context;
use bytes::Bytes;
use derivative::Derivative;
use wasm_bindgen::JsCast;
use wasmer::js::AsJs;
use wasmer_wasix::{
    WasiFunctionEnv,
    runtime::task_manager::{
        LocalTaskSpawner, SpawnMemoryTypeOrStore, SpawnType, TaskWasm, TaskWasmRecycle,
        TaskWasmRecycleProperties, TaskWasmRunProperties,
    },
};
use wasmer_wasix_types::wasi::ExitCode;

pub(crate) fn to_scheduler_message(task: TaskWasm) -> SchedulerMessage {
    SchedulerMessage::SpawnWasm(SpawnWasm(task))
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) struct SpawnWasm(#[derivative(Debug = "ignore")] TaskWasm);

impl SpawnWasm {
    pub(crate) fn process(&self) -> wasmer_wasix::WasiProcess {
        self.0.env.process.clone()
    }

    pub(crate) fn task_key(&self) -> (u32, u32) {
        (self.0.env.pid().raw(), self.0.env.tid().raw())
    }
    pub(crate) async fn begin(mut self) -> ReadySpawnWasm {
        let result = match self.0.callbacks.trigger.take() {
            Some(trigger) => Some(trigger().await),
            None => None,
        };
        ReadySpawnWasm(self.0, result)
    }
}

pub(crate) struct ReadySpawnWasm(TaskWasm, Option<Result<Bytes, ExitCode>>);

impl ReadySpawnWasm {
    /// Run the thread to completion. Returns the size in bytes of the guest
    /// memory it used, which only this worker's garbage collector can free
    /// once the pool has dropped the finished process (wasmer-sdk#547).
    pub(crate) async fn execute(self) -> Result<f64, anyhow::Error> {
        let ReadySpawnWasm(task, trigger_result) = self;
        let mut attached = None;
        let (memory, instance_group) = match task.spawn_type {
            SpawnType::CreateMemory => (SpawnMemoryTypeOrStore::New, None),
            SpawnType::CreateMemoryOfType(ty) => (SpawnMemoryTypeOrStore::Type(ty), None),
            SpawnType::AttachMemory(memory) => {
                let mut store = task.env.runtime().new_store();
                let memory = memory.attach(&mut store);
                attached = Some(
                    memory
                        .as_jsvalue(&store)
                        .unchecked_into::<js_sys::WebAssembly::Memory>(),
                );
                (SpawnMemoryTypeOrStore::StoreAndMemory(store, memory), None)
            }
            SpawnType::NewLinkerInstanceGroup(data) => (SpawnMemoryTypeOrStore::New, Some(data)),
        };
        // A memory this thread created reaches only the recycle callback,
        // which WASIX calls with the final store when a process's main thread
        // exits.
        let created_bytes = Arc::new(AtomicU64::new(0));
        let recycle: Box<TaskWasmRecycle> = {
            let created_bytes = Arc::clone(&created_bytes);
            let recycle = task.callbacks.recycle;
            Box::new(move |props: TaskWasmRecycleProperties| {
                let bytes = props.memory.view(&props.store).data_size();
                created_bytes.store(bytes, Ordering::Relaxed);
                if let Some(recycle) = recycle {
                    recycle(props);
                }
            })
        };
        let (mut ctx, mut store) = WasiFunctionEnv::new_with_store(
            task.module,
            task.env,
            task.globals,
            memory,
            task.update_layout,
            task.call_initialize,
            instance_group,
        )
        .context("Failed to create WASI context")?;
        if let Some(pre_run) = task.callbacks.pre_run {
            pre_run(&mut ctx, &mut store).await;
        }
        (task.callbacks.run)(TaskWasmRunProperties {
            ctx,
            store,
            local_tasks: LocalTaskSpawner::new(|future| {
                wasm_bindgen_futures::spawn_local(future);
                Ok(())
            }),
            trigger_result,
            recycle: Some(recycle),
        })
        .await;
        // An attached memory may have grown while the thread ran.
        let attached_bytes = attached
            .and_then(|memory| js_sys::Reflect::get(&memory.buffer(), &"byteLength".into()).ok())
            .and_then(|length| length.as_f64())
            .unwrap_or(0.0);
        Ok(attached_bytes.max(created_bytes.load(Ordering::Relaxed) as f64))
    }
}
