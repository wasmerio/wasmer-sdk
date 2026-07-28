use derivative::Derivative;
use js_sys::WebAssembly;
use wasm_bindgen::JsValue;
use wasmer_types::ModuleHash;

use crate::tasks::{
    AsyncTask, BlockingModuleTask, BlockingTask, interop::Serializer, task_wasm::SpawnWasm,
};

/// A message that will be sent from the scheduler to a worker using
/// `postMessage()`.
#[derive(Debug)]
pub(crate) enum PostMessagePayload {
    Async(AsyncJob),
    Blocking(BlockingJob),
    Notification(Notification),
}

impl PostMessagePayload {
    pub(crate) fn would_block(&self) -> bool {
        matches!(self, PostMessagePayload::Blocking(_))
    }
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum BlockingJob {
    Thunk(#[derivative(Debug(format_with = "crate::worker_utils::hidden"))] BlockingTask),
    SpawnWithModule {
        module: WebAssembly::Module,
        #[derivative(Debug(format_with = "crate::worker_utils::hidden"))]
        task: BlockingModuleTask,
    },
    SpawnWithModuleAndMemory {
        module: WebAssembly::Module,
        /// An instance of the WebAssembly linear memory that has already been
        /// created.
        memory: Option<WebAssembly::Memory>,
        spawn_wasm: SpawnWasm,
    },
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum AsyncJob {
    Thunk(#[derivative(Debug(format_with = "crate::worker_utils::hidden"))] AsyncTask),
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum Notification {
    CacheModule {
        hash: ModuleHash,
        module: WebAssembly::Module,
    },
}

mod consts {
    pub(crate) const TYPE_SPAWN_ASYNC: &str = "spawn-async";
    pub(crate) const TYPE_SPAWN_BLOCKING: &str = "spawn-blocking";
    pub(crate) const TYPE_CACHE_MODULE: &str = "cache-module";
    pub(crate) const TYPE_SPAWN_WITH_MODULE: &str = "spawn-with-module";
    pub(crate) const TYPE_SPAWN_WITH_MODULE_AND_MEMORY: &str = "spawn-with-module-and-memory";
    pub(crate) const PTR: &str = "ptr";
    pub(crate) const MODULE: &str = "module";
    pub(crate) const MEMORY: &str = "memory";
    pub(crate) const MODULE_HASH: &str = "module-hash";
}

impl PostMessagePayload {
    pub(crate) fn into_js(self) -> Result<JsValue, crate::worker_utils::Error> {
        match self {
            PostMessagePayload::Async(AsyncJob::Thunk(task)) => {
                Serializer::new(consts::TYPE_SPAWN_ASYNC)
                    .boxed(consts::PTR, task)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::Thunk(task)) => {
                Serializer::new(consts::TYPE_SPAWN_BLOCKING)
                    .boxed(consts::PTR, task)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModule { module, task }) => {
                Serializer::new(consts::TYPE_SPAWN_WITH_MODULE)
                    .boxed(consts::PTR, task)
                    .set(consts::MODULE, module)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            }) => Serializer::new(consts::TYPE_SPAWN_WITH_MODULE_AND_MEMORY)
                .boxed(consts::PTR, spawn_wasm)
                .set(consts::MODULE, module)
                .set(consts::MEMORY, memory)
                .finish(),
            PostMessagePayload::Notification(Notification::CacheModule { hash, module }) => {
                Serializer::new(consts::TYPE_CACHE_MODULE)
                    .set(consts::MODULE_HASH, hash.to_string())
                    .set(consts::MODULE, module)
                    .finish()
            }
        }
    }

    /// Try to convert a [`PostMessagePayload`] back from a [`JsValue`].
    ///
    /// # Safety
    ///
    /// This can only be called if the original [`JsValue`] was created using
    /// [`PostMessagePayload::into_js()`].
    pub(crate) unsafe fn try_from_js(value: JsValue) -> Result<Self, crate::worker_utils::Error> {
        let de = crate::tasks::interop::Deserializer::new(value);

        // Safety: Keep this in sync with PostMessagePayload::to_js()
        match de.ty()?.as_str() {
            consts::TYPE_SPAWN_ASYNC => {
                let task = unsafe { de.boxed(consts::PTR)? };
                Ok(PostMessagePayload::Async(AsyncJob::Thunk(task)))
            }
            consts::TYPE_SPAWN_BLOCKING => {
                let task = unsafe { de.boxed(consts::PTR)? };
                Ok(PostMessagePayload::Blocking(BlockingJob::Thunk(task)))
            }
            consts::TYPE_CACHE_MODULE => {
                let module = de.js(consts::MODULE)?;
                let hash = de.string(consts::MODULE_HASH)?;
                let hash = crate::worker_utils::module_hash_from_hex(&hash)?;

                Ok(PostMessagePayload::Notification(
                    Notification::CacheModule { hash, module },
                ))
            }
            consts::TYPE_SPAWN_WITH_MODULE => {
                let task = unsafe { de.boxed(consts::PTR)? };
                let module = de.js(consts::MODULE)?;

                Ok(PostMessagePayload::Blocking(BlockingJob::SpawnWithModule {
                    module,
                    task,
                }))
            }
            consts::TYPE_SPAWN_WITH_MODULE_AND_MEMORY => {
                let module = de.js(consts::MODULE)?;
                let memory = de.js(consts::MEMORY).ok();
                let spawn_wasm = unsafe { de.boxed(consts::PTR)? };

                Ok(PostMessagePayload::Blocking(
                    BlockingJob::SpawnWithModuleAndMemory {
                        module,
                        memory,
                        spawn_wasm,
                    },
                ))
            }
            other => Err(anyhow::anyhow!("Unknown message type: {other}").into()),
        }
    }
}
