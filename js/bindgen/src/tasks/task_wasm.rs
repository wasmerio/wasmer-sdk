//! Execute a WASIX task after the JS backend's objects have been transported.
use crate::tasks::SchedulerMessage;
use anyhow::Context;
use bytes::Bytes;
use derivative::Derivative;
use wasmer_wasix::{
    WasiFunctionEnv,
    runtime::task_manager::{
        LocalTaskSpawner, SpawnMemoryTypeOrStore, SpawnType, TaskWasm, TaskWasmRunProperties,
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
    pub(crate) async fn execute(self) -> Result<(), anyhow::Error> {
        let ReadySpawnWasm(task, trigger_result) = self;
        let (memory, instance_group) = match task.spawn_type {
            SpawnType::CreateMemory => (SpawnMemoryTypeOrStore::New, None),
            SpawnType::CreateMemoryOfType(ty) => (SpawnMemoryTypeOrStore::Type(ty), None),
            SpawnType::AttachMemory(memory) => {
                let mut store = task.env.runtime().new_store();
                let memory = memory.attach(&mut store);
                (SpawnMemoryTypeOrStore::StoreAndMemory(store, memory), None)
            }
            SpawnType::NewLinkerInstanceGroup(data) => (SpawnMemoryTypeOrStore::New, Some(data)),
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
            recycle: task.callbacks.recycle,
        })
        .await;
        Ok(())
    }
}
