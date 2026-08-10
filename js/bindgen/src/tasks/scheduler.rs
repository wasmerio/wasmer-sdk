use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Debug,
    sync::atomic::{AtomicU32, Ordering},
};

use anyhow::{Context, Error};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::mpsc::{self};
use tracing::Instrument;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use wasmer::js::AsJs;
use wasmer_types::ModuleHash;

use crate::tasks::{
    AsyncJob, BlockingJob, CapiTransfer, Notification, PostMessagePayload, SchedulerMessage,
    WorkerHandle, WorkerMessage,
};
use crate::worker_utils::HostTimer;

/// A handle for interacting with the threadpool's scheduler.
#[derive(Debug, Clone)]
pub(crate) struct Scheduler {
    scheduler_thread_id: u32,
    channel: UnboundedSender<SchedulerMessage>,
}

impl Scheduler {
    /// Spin up a scheduler on the current thread and get a channel that can be
    /// used to communicate with it.
    pub(crate) fn spawn() -> Scheduler {
        let (sender, mut receiver) = mpsc::unbounded_channel();

        let thread_id = wasmer::js::current_thread_id();
        // Safety: we just got the thread ID.
        let sender = unsafe { Scheduler::new(sender, thread_id) };

        let mut scheduler = SchedulerState::new(sender.clone());

        tracing::debug!(thread_id, "Spinning up the scheduler");
        wasm_bindgen_futures::spawn_local(
            async move {
                while let Some(msg) = receiver.recv().await {
                    tracing::trace!(?msg, "Executing a message");
                    if let SchedulerMessage::Close = msg {
                        break;
                    }
                    if let Err(e) = scheduler.execute(msg) {
                        tracing::error!(error = &*e, "An error occurred while handling a message");
                    }
                }

                tracing::debug!("Shutting down the scheduler");
                drop(scheduler);
            }
            .in_current_span()
            .instrument(tracing::debug_span!("scheduler", thread_id = thread_id)),
        );

        sender
    }

    /// # Safety
    ///
    /// The [`SchedulerMessage`] type is marked as `!Send` because
    /// [`wasmer::Module`] and friends are `!Send` when compiled for the
    /// browser.
    ///
    /// The `scheduler_thread_id` must match the [`wasmer::current_thread_id()`]
    /// otherwise these `!Send` values will be sent between threads.
    unsafe fn new(channel: UnboundedSender<SchedulerMessage>, scheduler_thread_id: u32) -> Self {
        debug_assert_eq!(scheduler_thread_id, wasmer::js::current_thread_id());
        tracing::debug!(
            current_thread = wasmer::js::current_thread_id(),
            "Creating Scheduler"
        );
        Scheduler {
            channel,
            scheduler_thread_id,
        }
    }

    pub fn send(&self, msg: SchedulerMessage) -> Result<(), Error> {
        if wasmer::js::current_thread_id() == self.scheduler_thread_id {
            tracing::debug!(
                current_thread = wasmer::js::current_thread_id(),
                ?msg,
                "Sending message to scheduler"
            );
            // It's safe to send the message to the scheduler.
            self.channel
                .send(msg)
                .map_err(|_| Error::msg("Scheduler is dead"))?;
            Ok(())
        } else {
            // We are in a child worker so we need to emit the message via
            // postMessage() and let the WorkerHandle forward it to the
            // scheduler.
            WorkerMessage::Scheduler(msg)
                .emit()
                .map_err(|e| e.into_anyhow())?;
            Ok(())
        }
    }

    pub fn close(&self) {
        let _ = self.channel.send(SchedulerMessage::Close);
    }

    pub fn is_closed(&self) -> bool {
        self.channel.is_closed()
    }
}

// Safety: The only way our !Send messages will be sent to the scheduler is if
// they are on the same thread. This is enforced via Scheduler::new()'s
// invariants.
unsafe impl Send for Scheduler {}
unsafe impl Sync for Scheduler {}

// Note: `Scheduler` deliberately has no `Drop` impl. Clones live inside
// `SchedulerState`, so close-on-drop would tear the pool down while it is
// still running; `ThreadPool` owns the lifecycle and closes on its own drop.

/// The state for the actor in charge of the threadpool.
#[derive(Debug)]
struct SchedulerState {
    /// Workers that are able to receive work.
    idle: VecDeque<WorkerHandle>,
    /// Workers that are currently blocked on synchronous operations and can't
    /// receive work at this time.
    busy: VecDeque<WorkerHandle>,
    /// A channel that can be used to send messages to this scheduler.
    mailbox: Scheduler,
    cached_modules: BTreeMap<ModuleHash, js_sys::WebAssembly::Module>,
    /// Nested WebAssembly objects waiting to travel with the next blocking
    /// task emitted by their source worker.
    pending_capi_transfers: BTreeMap<u32, BTreeMap<(u32, i32), JsValue>>,
    /// Published host values retained until the native owner releases its
    /// handle. This lifetime registry is deliberately separate from the
    /// one-shot task attachment queue above.
    capi_values: BTreeMap<(u32, i32), JsValue>,
    /// Workers waiting for a host value which was not attached to their
    /// original task dispatch. Requests may race ahead of publication.
    pending_capi_requests: BTreeMap<(u32, i32), BTreeSet<u32>>,
    /// Workers which received each host value, used to discard unused copies
    /// when the actual consumer releases the handle.
    capi_recipients: BTreeMap<(u32, i32), BTreeSet<u32>>,
    /// The worker which originally published each value. This survives task
    /// attachment so a later delete can release the source worker's copy.
    capi_origins: BTreeMap<(u32, i32), u32>,
    /// The browser worker executing each WASIX WebAssembly thread.
    wasm_workers: BTreeMap<(u32, u32), WasmWorker>,
    /// Host timers keyed by the ID allocated in the originating worker.
    sleeps: BTreeMap<(Option<u32>, u32), ScheduledSleep>,
    /// A dedicated Web Worker which may safely invoke Rust cross-thread
    /// wakers. Browser main threads cannot enter the wasm mutex/condvar path
    /// used by `virtual_mio::block_on`, because that path uses `Atomics.wait`.
    wake_worker: Option<WorkerHandle>,
}

struct ScheduledSleep {
    _timer: HostTimer,
    source_worker_id: Option<u32>,
    completion: tokio::sync::oneshot::Sender<()>,
}

impl Debug for ScheduledSleep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScheduledSleep")
            .field("timer", &"host")
            .field("source_worker_id", &self.source_worker_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct WasmWorker {
    worker_id: u32,
    completion: Option<WasmThreadCompletion>,
}

#[derive(Debug)]
struct WasmThreadCompletion {
    memory: js_sys::WebAssembly::Memory,
    control_block: u32,
}

impl WasmThreadCompletion {
    const THREAD_START_PTHREAD_WORD: u32 = 4;
    const PTHREAD_PREV_WORD: u32 = 1;
    const PTHREAD_NEXT_WORD: u32 = 2;
    const PTHREAD_TID_WORD: u32 = 5;
    const PTHREAD_DETACH_STATE_WORD: u32 = 7;

    fn from_thread_start(
        memory: &js_sys::WebAssembly::Memory,
        thread_start_ptr: Option<u64>,
    ) -> Option<Self> {
        // WASIX libc stores its pthread control block in reserved[0] of the
        // thread-start record. Its detach-state futex is 28 bytes into that
        // control block. The scheduler completes this futex after terminating
        // a browser worker, just as the guest trampoline does on normal exit.
        let start_ptr: u32 = thread_start_ptr?.try_into().ok()?;
        if start_ptr % 4 != 0 {
            return None;
        }
        let view = js_sys::Int32Array::new(&memory.buffer());
        let control_block =
            js_sys::Atomics::load(&view, start_ptr / 4 + Self::THREAD_START_PTHREAD_WORD).ok()?
                as u32;
        let state_address = control_block.checked_add(Self::PTHREAD_DETACH_STATE_WORD * 4)?;
        if control_block == 0 || state_address % 4 != 0 {
            return None;
        }
        Some(Self {
            memory: memory.clone(),
            control_block,
        })
    }

    fn finish(self) {
        // Shared memories can grow after this thread starts. A fresh view is
        // required to reach pthreads allocated after a grow.
        let memory = js_sys::Int32Array::new(&self.memory.buffer());
        let control_index = self.control_block / 4;
        let previous = js_sys::Atomics::load(&memory, control_index + Self::PTHREAD_PREV_WORD)
            .ok()
            .map(|v| v as u32);
        let next = js_sys::Atomics::load(&memory, control_index + Self::PTHREAD_NEXT_WORD)
            .ok()
            .map(|v| v as u32);
        // A forcibly terminated worker cannot run WASIX libc's pthread-exit
        // trampoline. Complete the small piece of guest bookkeeping which the
        // kernel normally owns: unlink the thread, clear its TID, then publish
        // DT_EXITED. The browser Worker is already gone, so no guest code can
        // race these writes.
        if let (Some(previous), Some(next)) = (previous, next)
            && previous != 0
            && next != 0
            && previous % 4 == 0
            && next % 4 == 0
        {
            let _ = js_sys::Atomics::store(
                &memory,
                previous / 4 + Self::PTHREAD_NEXT_WORD,
                next as i32,
            );
            let _ = js_sys::Atomics::store(
                &memory,
                next / 4 + Self::PTHREAD_PREV_WORD,
                previous as i32,
            );
            let _ = js_sys::Atomics::store(
                &memory,
                control_index + Self::PTHREAD_PREV_WORD,
                self.control_block as i32,
            );
            let _ = js_sys::Atomics::store(
                &memory,
                control_index + Self::PTHREAD_NEXT_WORD,
                self.control_block as i32,
            );
        }
        let _ = js_sys::Atomics::store(&memory, control_index + Self::PTHREAD_TID_WORD, 0);
        let state_index = control_index + Self::PTHREAD_DETACH_STATE_WORD;
        let _ = js_sys::Atomics::store(&memory, state_index, 0);
        let _ = js_sys::Atomics::notify(&memory, state_index);
    }
}

impl SchedulerState {
    fn new(mailbox: Scheduler) -> Self {
        SchedulerState {
            idle: VecDeque::new(),
            busy: VecDeque::new(),
            mailbox,
            cached_modules: BTreeMap::new(),
            pending_capi_transfers: BTreeMap::new(),
            capi_values: BTreeMap::new(),
            pending_capi_requests: BTreeMap::new(),
            capi_recipients: BTreeMap::new(),
            capi_origins: BTreeMap::new(),
            wasm_workers: BTreeMap::new(),
            sleeps: BTreeMap::new(),
            wake_worker: None,
        }
    }

    fn execute(&mut self, message: SchedulerMessage) -> Result<(), Error> {
        self.execute_from(None, message)
    }

    fn execute_from(
        &mut self,
        source_worker_id: Option<u32>,
        message: SchedulerMessage,
    ) -> Result<(), Error> {
        match message {
            SchedulerMessage::Close => {
                // Unreachable in practice: the receive loop breaks on Close
                // before calling execute(), and dropping the state terminates
                // every worker via WorkerHandle::drop.
                Ok(())
            }
            SchedulerMessage::SpawnAsync(task) => self.post_message_from(
                source_worker_id,
                PostMessagePayload::Async(AsyncJob::Thunk(task)),
            ),
            SchedulerMessage::SpawnBlocking(task) => self.post_message_from(
                source_worker_id,
                PostMessagePayload::Blocking(BlockingJob::Thunk(task)),
            ),
            SchedulerMessage::Sleep {
                sleep_id,
                millis,
                completion,
            } => self.arm_sleep(source_worker_id, sleep_id, millis, completion),
            SchedulerMessage::CancelSleep { sleep_id } => {
                self.cancel_sleep(source_worker_id, sleep_id);
                Ok(())
            }
            SchedulerMessage::SleepReady {
                source_worker_id,
                sleep_id,
            } => self.complete_sleep(source_worker_id, sleep_id),
            SchedulerMessage::FromWorker {
                source_worker_id,
                message,
            } => self.execute_from(Some(source_worker_id), *message),
            SchedulerMessage::CacheModule { hash, module } => {
                let module: js_sys::WebAssembly::Module = JsValue::from(module).unchecked_into();
                self.cached_modules.insert(hash, module.clone());

                for worker in self.idle.iter().chain(self.busy.iter()) {
                    worker.send(PostMessagePayload::Notification(
                        Notification::CacheModule {
                            hash,
                            module: module.clone(),
                        },
                    ))?;
                }

                Ok(())
            }
            SchedulerMessage::SpawnWithModule { module, task } => self.post_message_from(
                source_worker_id,
                PostMessagePayload::Blocking(BlockingJob::SpawnWithModule {
                    module: JsValue::from(module).unchecked_into(),
                    task,
                }),
            ),
            SchedulerMessage::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            } => {
                let temp_store = wasmer::Store::default();
                let memory: Option<js_sys::WebAssembly::Memory> =
                    memory.map(|m| m.as_jsvalue(&temp_store).dyn_into().unwrap());
                let module = JsValue::from(module).dyn_into().unwrap();
                let task_key = spawn_wasm.task_key();
                let completion = memory.as_ref().and_then(|memory| {
                    WasmThreadCompletion::from_thread_start(memory, spawn_wasm.thread_start_ptr())
                });

                self.post_wasm_message_from(
                    source_worker_id,
                    PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                        module,
                        memory,
                        spawn_wasm,
                    }),
                    task_key,
                    completion,
                )
            }
            SchedulerMessage::WorkerBusy { worker_id } => {
                move_worker(worker_id, &mut self.idle, &mut self.busy);
                tracing::trace!(
                    worker.id=worker_id,
                    idle_workers=?self.idle.iter().map(|w| w.id()).collect::<Vec<_>>(),
                    busy_workers=?self.busy.iter().map(|w| w.id()).collect::<Vec<_>>(),
                    "Worker marked as busy",
                );
                Ok(())
            }
            SchedulerMessage::TerminateWasmThread { pid, tid } => {
                scheduler_diag(format!("terminate wasm={pid}.{tid}"));
                self.terminate_wasm_thread((pid, tid));
                Ok(())
            }
            SchedulerMessage::WorkerIdle { worker_id } => {
                move_worker(worker_id, &mut self.busy, &mut self.idle);
                self.wasm_workers
                    .retain(|_, worker| worker.worker_id != worker_id);
                tracing::trace!(
                    worker.id=worker_id,
                    idle_workers=?self.idle.iter().map(|w| w.id()).collect::<Vec<_>>(),
                    busy_workers=?self.busy.iter().map(|w| w.id()).collect::<Vec<_>>(),
                    "Worker marked as idle",
                );
                scheduler_diag(format!(
                    "idle worker={} busy={} idle={} wasm={}",
                    worker_id,
                    self.busy.len(),
                    self.idle.len(),
                    self.wasm_workers.len(),
                ));
                Ok(())
            }
            SchedulerMessage::CapiShare {
                source_worker_id,
                registry_id,
                handle,
                value,
            } => {
                let key = (registry_id, handle);
                scheduler_diag(format!(
                    "capi share source={} registry={} handle={}",
                    source_worker_id, registry_id, handle,
                ));
                self.capi_origins.insert(key, source_worker_id);
                self.capi_values.insert(key, value.clone());
                self.pending_capi_transfers
                    .entry(source_worker_id)
                    .or_default()
                    .insert(key, value);
                self.fulfill_capi_requests(key)?;
                Ok(())
            }
            SchedulerMessage::CapiRequest {
                requesting_worker_id,
                registry_id,
                handle,
            } => {
                let key = (registry_id, handle);
                scheduler_diag(format!(
                    "capi request worker={} registry={} handle={} available={}",
                    requesting_worker_id,
                    registry_id,
                    handle,
                    self.pending_capi_value(key).is_some(),
                ));
                self.pending_capi_requests
                    .entry(key)
                    .or_default()
                    .insert(requesting_worker_id);
                self.fulfill_capi_requests(key)?;
                Ok(())
            }
            SchedulerMessage::CapiDelete {
                source_worker_id,
                registry_id,
                handle,
            } => {
                let key = (registry_id, handle);
                scheduler_diag(format!(
                    "capi delete source={} registry={} handle={}",
                    source_worker_id, registry_id, handle,
                ));
                self.remove_pending_capi_value(key);
                self.pending_capi_requests.remove(&key);
                let mut workers_to_drop = self.capi_recipients.remove(&key).unwrap_or_default();
                if let Some(origin_worker_id) = self.capi_origins.remove(&key) {
                    workers_to_drop.insert(origin_worker_id);
                }
                workers_to_drop.remove(&source_worker_id);
                for worker_id in workers_to_drop {
                    if let Some(worker) = self.worker(worker_id) {
                        worker.send_capi_drop(registry_id, handle)?;
                    }
                }
                Ok(())
            }
            SchedulerMessage::Markers { uninhabited, .. } => match uninhabited {},
        }
    }

    fn arm_sleep(
        &mut self,
        source_worker_id: Option<u32>,
        sleep_id: u32,
        millis: i32,
        completion: tokio::sync::oneshot::Sender<()>,
    ) -> Result<(), Error> {
        self.cancel_sleep(source_worker_id, sleep_id);
        scheduler_diag(format!(
            "sleep arm source={source_worker_id:?} id={sleep_id} millis={millis}"
        ));

        let timer = HostTimer::new(millis);
        let promise = timer.promise();
        let mailbox = self.mailbox.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let _ = JsFuture::from(promise).await;
            let _ = mailbox.send(SchedulerMessage::SleepReady {
                source_worker_id,
                sleep_id,
            });
        });
        self.sleeps.insert(
            (source_worker_id, sleep_id),
            ScheduledSleep {
                _timer: timer,
                source_worker_id,
                completion,
            },
        );
        Ok(())
    }

    fn cancel_sleep(&mut self, source_worker_id: Option<u32>, sleep_id: u32) {
        let Some(_sleep) = self.sleeps.remove(&(source_worker_id, sleep_id)) else {
            return;
        };
        scheduler_diag(format!(
            "sleep cancel source={source_worker_id:?} id={sleep_id}"
        ));
    }

    fn complete_sleep(
        &mut self,
        source_worker_id: Option<u32>,
        sleep_id: u32,
    ) -> Result<(), Error> {
        let Some(sleep) = self.sleeps.remove(&(source_worker_id, sleep_id)) else {
            return Ok(());
        };
        scheduler_diag(format!(
            "sleep ready source={source_worker_id:?} id={sleep_id}"
        ));

        if sleep.source_worker_id.is_none() {
            let _ = sleep.completion.send(());
            return Ok(());
        }

        if self.wake_worker.is_none() {
            let worker = self.start_worker()?;
            scheduler_diag(format!("create wake-worker={}", worker.id()));
            self.wake_worker = Some(worker);
        }
        let worker = self.wake_worker.as_ref().unwrap();
        let completion = sleep.completion;
        let task = Box::new(move || {
            Box::pin(async move {
                let _ = completion.send(());
            }) as futures::future::LocalBoxFuture<'static, ()>
        });
        scheduler_diag(format!(
            "sleep deliver wake-worker={} source={source_worker_id:?} id={sleep_id}",
            worker.id()
        ));
        worker.send(PostMessagePayload::Async(AsyncJob::Thunk(task)))
    }

    fn post_message_from(
        &mut self,
        source_worker_id: Option<u32>,
        msg: PostMessagePayload,
    ) -> Result<(), Error> {
        let would_block = msg.would_block();
        let reason = match &msg {
            PostMessagePayload::Async(_) => "async",
            PostMessagePayload::Blocking(BlockingJob::Thunk(_)) => "blocking-thunk",
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModule { .. }) => "blocking-module",
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory { .. }) => {
                "blocking-wasm"
            }
            PostMessagePayload::Notification(_) => "notification",
        };
        let worker = self.next_available_worker(reason)?;
        let transfers = self.take_capi_transfers(source_worker_id, would_block, Some(worker.id()));
        worker
            .send_with_capi_transfers(msg, transfers)
            .with_context(|| format!("Unable to send a message to worker {}", worker.id()))?;

        if would_block {
            self.busy.push_back(worker);
        } else {
            self.idle.push_back(worker);
        }

        Ok(())
    }

    fn post_wasm_message_from(
        &mut self,
        source_worker_id: Option<u32>,
        msg: PostMessagePayload,
        task_key: (u32, u32),
        completion: Option<WasmThreadCompletion>,
    ) -> Result<(), Error> {
        let reason = format!("wasm-{}.{}", task_key.0, task_key.1);
        let worker = self.next_available_worker(&reason)?;
        let transfers = self.take_capi_transfers(source_worker_id, true, Some(worker.id()));
        self.wasm_workers.insert(
            task_key,
            WasmWorker {
                worker_id: worker.id(),
                completion,
            },
        );
        worker
            .send_with_capi_transfers(msg, transfers)
            .with_context(|| format!("Unable to send a message to worker {}", worker.id()))?;
        self.busy.push_back(worker);
        Ok(())
    }

    fn next_available_worker(&mut self, reason: &str) -> Result<WorkerHandle, Error> {
        // First, try to send the message to an idle worker
        if let Some(worker) = self.idle.pop_front() {
            tracing::trace!(
                worker.id = worker.id(),
                "Sending the message to an idle worker"
            );
            return Ok(worker);
        }

        // Rather than sending the task to one of the blocking workers,
        // let's spawn a new worker

        let worker = self.start_worker()?;
        scheduler_diag(format!(
            "create worker={} reason={} busy={} idle={} wasm={}",
            worker.id(),
            reason,
            self.busy.len(),
            self.idle.len(),
            self.wasm_workers.len(),
        ));
        tracing::trace!(
            worker.id = worker.id(),
            "Sending the message to a new worker"
        );
        Ok(worker)
    }

    fn start_worker(&mut self) -> Result<WorkerHandle, Error> {
        // Note: By using a monotonically incrementing counter, we can make sure
        // every single worker created with this shared linear memory will get a
        // unique ID.
        static NEXT_ID: AtomicU32 = AtomicU32::new(1);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        let handle = WorkerHandle::spawn(id, self.mailbox.clone())?;

        // Prime the worker's module cache
        for (&hash, module) in &self.cached_modules {
            let msg = PostMessagePayload::Notification(Notification::CacheModule {
                hash,
                module: module.clone(),
            });
            handle.send(msg)?;
        }

        Ok(handle)
    }

    fn take_capi_transfers(
        &mut self,
        source_worker_id: Option<u32>,
        would_block: bool,
        destination_worker_id: Option<u32>,
    ) -> Vec<CapiTransfer> {
        if !would_block {
            return Vec::new();
        }
        let Some(source_worker_id) = source_worker_id else {
            return Vec::new();
        };
        let transfers: Vec<CapiTransfer> = self
            .pending_capi_transfers
            .remove(&source_worker_id)
            .into_iter()
            .flat_map(|transfers| transfers.into_iter())
            .map(|((registry_id, handle), value)| CapiTransfer {
                registry_id,
                handle,
                value,
            })
            .collect();
        for transfer in &transfers {
            let key = (transfer.registry_id, transfer.handle);
            if let Some(worker_id) = destination_worker_id {
                self.capi_recipients
                    .entry(key)
                    .or_default()
                    .insert(worker_id);
            }
        }
        transfers
    }

    fn fulfill_capi_requests(&mut self, key: (u32, i32)) -> Result<(), Error> {
        let Some(value) = self.pending_capi_value(key) else {
            return Ok(());
        };
        let Some(requesting_workers) = self.pending_capi_requests.remove(&key) else {
            return Ok(());
        };

        for worker_id in requesting_workers {
            let Some(worker) = self.worker(worker_id) else {
                tracing::warn!(
                    worker.id = worker_id,
                    "C API value requester is no longer running"
                );
                continue;
            };
            worker.send_capi_transfer(CapiTransfer {
                registry_id: key.0,
                handle: key.1,
                value: value.clone(),
            })?;
            self.capi_recipients
                .entry(key)
                .or_default()
                .insert(worker_id);
        }
        Ok(())
    }

    fn pending_capi_value(&self, key: (u32, i32)) -> Option<JsValue> {
        self.capi_values.get(&key).cloned()
    }

    fn remove_pending_capi_value(&mut self, key: (u32, i32)) -> Option<JsValue> {
        let empty_sources: Vec<u32> = self
            .pending_capi_transfers
            .iter_mut()
            .filter_map(|(&source, values)| {
                values.remove(&key);
                values.is_empty().then_some(source)
            })
            .collect();
        for source in empty_sources {
            self.pending_capi_transfers.remove(&source);
        }
        self.capi_values.remove(&key)
    }

    fn worker(&self, worker_id: u32) -> Option<&WorkerHandle> {
        self.idle
            .iter()
            .chain(self.busy.iter())
            .find(|worker| worker.id() == worker_id)
    }

    fn terminate_wasm_thread(&mut self, task_key: (u32, u32)) {
        let Some(worker) = self.wasm_workers.remove(&task_key) else {
            return;
        };
        let worker_id = worker.worker_id;

        self.idle.retain(|worker| worker.id() != worker_id);
        self.busy.retain(|worker| worker.id() != worker_id);
        self.wasm_workers
            .retain(|_, worker| worker.worker_id != worker_id);
        self.pending_capi_requests.retain(|_, workers| {
            workers.remove(&worker_id);
            !workers.is_empty()
        });
        if let Some(completion) = worker.completion {
            completion.finish();
        }
    }
}

fn scheduler_diagnostics_enabled() -> bool {
    js_sys::Reflect::get(
        &js_sys::global(),
        &JsValue::from_str("__wasmerSchedulerDiagnostics"),
    )
    .ok()
    .and_then(|value| value.as_bool())
    .unwrap_or(false)
}

fn scheduler_diag(message: String) {
    if scheduler_diagnostics_enabled() {
        web_sys::console::error_1(&format!("[wasmer-scheduler] {message}").into());
    }
}

fn move_worker(worker_id: u32, from: &mut VecDeque<WorkerHandle>, to: &mut VecDeque<WorkerHandle>) {
    if let Some(ix) = from.iter().position(|w| w.id() == worker_id) {
        let worker = from.remove(ix).unwrap();
        to.push_back(worker);
    }
}

#[cfg(test)]
mod tests {
    use js_sys::{Int32Array, Object, Reflect, WebAssembly};
    use tokio::sync::oneshot;
    use wasm_bindgen::JsValue;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    async fn spawn_an_async_function() {
        let (sender, receiver) = oneshot::channel();
        let (tx, _) = mpsc::unbounded_channel();
        let tx = unsafe { Scheduler::new(tx, wasmer::js::current_thread_id()) };
        let mut scheduler = SchedulerState::new(tx);
        let message = SchedulerMessage::SpawnAsync(Box::new(move || {
            Box::pin(async move {
                let _ = sender.send(42);
            })
        }));

        // we start off with no workers
        assert_eq!(scheduler.idle.len(), 0);
        assert_eq!(scheduler.busy.len(), 0);

        // then we run the message, which should start up a worker and send it
        // the job
        scheduler.execute(message).unwrap();

        // One worker should have been created and added to the "ready" queue
        // because it's just handling async workloads.
        assert_eq!(scheduler.idle.len(), 1);
        assert_eq!(scheduler.busy.len(), 0);

        // Make sure the background thread actually ran something and sent us
        // back a result
        assert_eq!(receiver.await.unwrap(), 42);
    }

    #[wasm_bindgen_test]
    fn capi_objects_attach_once_but_remain_available_until_release() {
        let (tx, _) = mpsc::unbounded_channel();
        let tx = unsafe { Scheduler::new(tx, wasmer::js::current_thread_id()) };
        let mut scheduler = SchedulerState::new(tx);
        scheduler
            .pending_capi_transfers
            .entry(7)
            .or_default()
            .insert((3, 11), JsValue::from_str("module"));
        scheduler
            .capi_values
            .insert((3, 11), JsValue::from_str("module"));

        assert!(
            scheduler
                .take_capi_transfers(Some(7), false, Some(8))
                .is_empty()
        );
        assert!(scheduler.pending_capi_transfers.contains_key(&7));

        let transfers = scheduler.take_capi_transfers(Some(7), true, Some(8));
        assert_eq!(transfers.len(), 1);
        assert_eq!(transfers[0].registry_id, 3);
        assert_eq!(transfers[0].handle, 11);
        assert!(!scheduler.pending_capi_transfers.contains_key(&7));
        assert!(
            scheduler
                .take_capi_transfers(Some(7), true, Some(9))
                .is_empty()
        );
        assert_eq!(
            scheduler
                .pending_capi_value((3, 11))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("module")
        );
    }

    #[wasm_bindgen_test]
    fn forced_thread_completion_uses_memory_after_growth() {
        let descriptor = Object::new();
        Reflect::set(&descriptor, &"initial".into(), &1.into()).unwrap();
        Reflect::set(&descriptor, &"maximum".into(), &2.into()).unwrap();
        Reflect::set(&descriptor, &"shared".into(), &JsValue::TRUE).unwrap();
        let memory = WebAssembly::Memory::new(&descriptor).unwrap();

        let start_ptr = 128_u32;
        let control_block = 65_536_u32 + 128;
        let before_growth = Int32Array::new(&memory.buffer());
        js_sys::Atomics::store(
            &before_growth,
            start_ptr / 4 + WasmThreadCompletion::THREAD_START_PTHREAD_WORD,
            control_block as i32,
        )
        .unwrap();
        let completion = WasmThreadCompletion::from_thread_start(&memory, Some(start_ptr.into()))
            .expect("valid thread-start record");

        assert_eq!(memory.grow(1), 1);
        let current = Int32Array::new(&memory.buffer());
        let previous = 256_u32;
        let next = 512_u32;
        let control_index = control_block / 4;
        js_sys::Atomics::store(
            &current,
            control_index + WasmThreadCompletion::PTHREAD_PREV_WORD,
            previous as i32,
        )
        .unwrap();
        js_sys::Atomics::store(
            &current,
            control_index + WasmThreadCompletion::PTHREAD_NEXT_WORD,
            next as i32,
        )
        .unwrap();
        js_sys::Atomics::store(
            &current,
            control_index + WasmThreadCompletion::PTHREAD_TID_WORD,
            42,
        )
        .unwrap();
        js_sys::Atomics::store(
            &current,
            control_index + WasmThreadCompletion::PTHREAD_DETACH_STATE_WORD,
            2,
        )
        .unwrap();

        completion.finish();

        assert_eq!(
            js_sys::Atomics::load(
                &current,
                previous / 4 + WasmThreadCompletion::PTHREAD_NEXT_WORD,
            )
            .unwrap(),
            next as i32,
        );
        assert_eq!(
            js_sys::Atomics::load(&current, next / 4 + WasmThreadCompletion::PTHREAD_PREV_WORD,)
                .unwrap(),
            previous as i32,
        );
        assert_eq!(
            js_sys::Atomics::load(
                &current,
                control_index + WasmThreadCompletion::PTHREAD_TID_WORD,
            )
            .unwrap(),
            0,
        );
        assert_eq!(
            js_sys::Atomics::load(
                &current,
                control_index + WasmThreadCompletion::PTHREAD_DETACH_STATE_WORD,
            )
            .unwrap(),
            0,
        );
    }
}
