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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use futures::channel::oneshot;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::wasm_bindgen_test;
    use wasmer::js::AsJs;
    use wasmer_wasix::{PluggableRuntime, WasiEnvBuilder, runtime::task_manager::TaskWasm};

    use crate::tasks::{SchedulerMessage, ThreadPool};

    use super::*;

    const TEST_WASM: &[u8] = &[
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03,
        0x02, 0x01, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d,
        0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, 0x0a,
        0x04, 0x01, 0x02, 0x00, 0x0b,
    ];

    #[wasm_bindgen_test]
    async fn round_trip_spawn_blocking() {
        let flag = Arc::new(AtomicBool::new(false));
        let msg = PostMessagePayload::Blocking(BlockingJob::Thunk({
            let flag = Arc::clone(&flag);
            Box::new(move || {
                flag.store(true, Ordering::SeqCst);
            })
        }));

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::Thunk(task)) => {
                task();
                assert!(flag.load(Ordering::SeqCst));
            }
            _ => unreachable!(),
        }
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_async() {
        let flag = Arc::new(AtomicBool::new(false));
        let msg = PostMessagePayload::Async(AsyncJob::Thunk({
            let flag = Arc::clone(&flag);
            Box::new(move || {
                Box::pin(async move {
                    flag.store(true, Ordering::SeqCst);
                })
            })
        }));

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Async(AsyncJob::Thunk(task)) => {
                task().await;
                assert!(flag.load(Ordering::SeqCst));
            }
            _ => unreachable!(),
        }
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_with_module() {
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, TEST_WASM).unwrap();
        let (sender, receiver) = oneshot::channel();
        let msg = PostMessagePayload::Blocking(BlockingJob::SpawnWithModule {
            module: JsValue::from(module).dyn_into().unwrap(),
            task: Box::new(|module| {
                sender.send(module.exports().count()).unwrap();
            }),
        });

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        let (module, task) = match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModule { module, task }) => {
                (module, task)
            }
            _ => unreachable!(),
        };
        task(module.into());
        assert_eq!(receiver.await.unwrap(), 2);
    }

    #[wasm_bindgen_test]
    async fn round_trip_cache_module() {
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, TEST_WASM).unwrap();
        let msg = PostMessagePayload::Notification(Notification::CacheModule {
            hash: ModuleHash::new(TEST_WASM),
            module: module.into(),
        });

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Notification(Notification::CacheModule { hash, module: _ }) => {
                assert_eq!(hash, ModuleHash::new(TEST_WASM));
            }
            _ => unreachable!(),
        }
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_with_module_and_memory() {
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, TEST_WASM).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let runtime = PluggableRuntime::new(Arc::new(ThreadPool::new(None)));
        let env = WasiEnvBuilder::new("program")
            .runtime(Arc::new(runtime))
            .build()
            .unwrap();
        let msg = crate::tasks::task_wasm::to_scheduler_message(TaskWasm::new(
            {
                let flag = Arc::clone(&flag);
                move |_| async move {
                    flag.store(true, Ordering::SeqCst);
                }
            },
            env,
            module,
            false,
            false,
        ))
        .unwrap();
        let msg = match msg {
            SchedulerMessage::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            } => PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module: module.into(),
                memory: memory.map(|memory| {
                    memory
                        .as_jsvalue(&wasmer::Store::default())
                        .dyn_into()
                        .unwrap()
                }),
                spawn_wasm,
            }),
            _ => unreachable!(),
        };

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        let (module, memory, spawn_wasm) = match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            }) => (module, memory, spawn_wasm),
            _ => unreachable!(),
        };
        spawn_wasm
            .begin()
            .await
            .execute(module, memory.into())
            .await
            .unwrap();
        assert!(flag.load(Ordering::SeqCst));
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
