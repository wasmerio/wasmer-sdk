use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Debug,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use anyhow::{Context, Error};
use futures::future::Either;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tracing::Instrument;
use wasm_bindgen::JsValue;

use crate::{
    tasks::{
        AsyncJob, BlockingJob, CapiTransfer, PoolOptions, PostMessagePayload, SchedulerMessage,
        WorkerHandle, WorkerMessage, task_wasm::SpawnWasm, worker_gate::WorkerGate,
    },
    worker_utils::GlobalScope,
};

/// How long a SIGKILLed WASIX thread gets to unwind on its own before its
/// worker is force-terminated. A thread blocked in a syscall is woken by the
/// kill and normally unwinds within milliseconds; only a guest that never
/// calls into the runtime (a busy loop) needs the forced path.
/// Overridable with `globalThis.__wasmerTerminateGraceMs`.
const TERMINATE_GRACE_MS: i32 = 500;

/// How long pool shutdown waits for workers to exit from their own message
/// loops before force-terminating the rest.
const SHUTDOWN_GRACE_MS: i32 = 2_000;

/// How long a guest spawn waits for a draining worker (one whose WASIX threads
/// have all finished) to report Idle before another worker is started.
///
/// A guest's exit is observable, so `run()` and `close()` resolve, before its
/// worker has unwound and reported Idle. Without the wait, back-to-back guests
/// alternate between two workers, and each worker keeps its own backlog of
/// dead guest memories (wasmer-sdk#547). The bound only matters when a
/// finished thread's worker never unwinds.
/// Overridable with `globalThis.__wasmerDrainWaitMs`.
const DRAIN_WAIT_MS: i32 = 250;

/// A handle for interacting with the threadpool's scheduler.
#[derive(Debug, Clone)]
pub(crate) struct Scheduler {
    scheduler_thread_id: u32,
    channel: UnboundedSender<SchedulerMessage>,
    failure: Arc<Mutex<Option<String>>>,
}

impl Scheduler {
    /// Spin up a scheduler on the current thread and get a channel that can be
    /// used to communicate with it.
    pub(crate) fn spawn(options: PoolOptions) -> Scheduler {
        let (sender, mut receiver) = mpsc::unbounded_channel();

        let thread_id = wasmer::js::current_thread_id();
        // Safety: we just got the thread ID.
        let sender = unsafe { Scheduler::new(sender, thread_id) };

        let mut scheduler = SchedulerState::new(sender.clone(), options);

        tracing::debug!(thread_id, "Spinning up the scheduler");
        wasm_bindgen_futures::spawn_local(
            async move {
                let mut close_completions = Vec::new();
                loop {
                    let Some(msg) = receiver.recv().await else {
                        break;
                    };
                    tracing::trace!(?msg, "Executing a message");
                    if let SchedulerMessage::WorkerFailed = msg {
                        // A trapped worker cannot send its final idle message.
                        // Finish outstanding process joins before dropping the
                        // pool, and preserve the failure for client shutdown.
                        for worker in scheduler.wasm_workers.values() {
                            worker.process.terminate(1.into());
                        }
                        for deferred in &scheduler.deferred_wasm {
                            deferred.task.process().terminate(1.into());
                        }
                        break;
                    }
                    if let SchedulerMessage::Close { completion, drain } = msg {
                        if let Some(completion) = completion {
                            close_completions.push(completion);
                        }
                        if !drain || scheduler.blocking_tasks_are_idle() {
                            break;
                        }
                        scheduler_diag(format!(
                            "draining close busy={} wasm={}",
                            scheduler.busy.len(),
                            scheduler.wasm_workers.len(),
                        ));
                        continue;
                    }
                    if let Err(e) = scheduler.execute(msg) {
                        tracing::error!(error = &*e, "An error occurred while handling a message");
                    }
                    if !close_completions.is_empty() && scheduler.blocking_tasks_are_idle() {
                        break;
                    }
                }

                tracing::debug!("Shutting down the scheduler");
                scheduler
                    .shutdown(&mut receiver, &mut close_completions)
                    .await;
                for completion in close_completions {
                    let _ = completion.send(());
                }
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
            failure: Arc::new(Mutex::new(None)),
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

    pub fn worker_failed(&self, worker_id: u32, message: String) {
        let mut failure = self.failure.lock().unwrap();
        failure.get_or_insert_with(|| format!("worker {worker_id} failed: {message}"));
        drop(failure);
        let _ = self.channel.send(SchedulerMessage::WorkerFailed);
    }

    pub fn close(&self) {
        let _ = self.channel.send(SchedulerMessage::Close {
            completion: None,
            drain: false,
        });
    }

    pub async fn close_and_wait(&self) -> Result<(), Error> {
        let (completion, receiver) = tokio::sync::oneshot::channel();
        if self
            .channel
            .send(SchedulerMessage::Close {
                completion: Some(completion),
                drain: true,
            })
            .is_ok()
        {
            let _ = receiver.await;
        }
        match self.failure.lock().unwrap().as_ref() {
            Some(message) => Err(Error::msg(message.clone())),
            None => Ok(()),
        }
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
    /// Never receives guest tasks or their shared-object snapshots.
    timer_worker: Option<WorkerHandle>,
    retire_wasm_workers: bool,
    retiring: BTreeSet<u32>,
    /// Workers retired at their own request because they cannot collect
    /// their dead guest memory, kept until they report Retired.
    stopping: BTreeMap<u32, WorkerHandle>,
    /// Busy workers that asked to retire; they retire instead of going idle.
    retire_when_idle: BTreeSet<u32>,
    /// Workers that received a WASIX thread since they were last idle.
    /// `wasm_workers` cannot tell: every sandbox's main thread has the same
    /// PID and TID, so an overlapping guest replaces the entry of the one
    /// still unwinding.
    ran_wasm: BTreeSet<u32>,
    guest_memory_gc_budget: u64,
    /// A channel that can be used to send messages to this scheduler.
    mailbox: Scheduler,
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
    /// Workers whose WASIX thread was killed, waiting out their grace period.
    /// The value identifies the pending `ForceTerminate`.
    doomed: BTreeMap<u32, u64>,
    next_doom_generation: u64,
    /// Every live worker's gate, kept until the worker is known to be gone so
    /// its thread memory can be freed then.
    gates: BTreeMap<u32, &'static WorkerGate>,
    /// Guest spawns waiting for a draining worker, oldest first. See
    /// [`DRAIN_WAIT_MS`].
    deferred_wasm: VecDeque<DeferredWasm>,
    next_drain_generation: u64,
}

#[derive(Debug)]
struct WasmWorker {
    worker_id: u32,
    process: wasmer_wasix::WasiProcess,
}

impl WasmWorker {
    /// Whether the WASIX thread `tid` of this task has finished, so that only
    /// unwinding is left on its worker.
    fn thread_finished(&self, tid: u32) -> bool {
        self.process.try_join().is_some()
            || self
                .process
                .get_thread(&wasmer_wasix::WasiThreadId::from(tid))
                .map_or(true, |thread| thread.try_join().is_some())
    }
}

#[derive(Debug)]
struct DeferredWasm {
    source_worker_id: Option<u32>,
    task: SpawnWasm,
    /// Identifies the [`SchedulerMessage::DrainWaitElapsed`] that ends the wait.
    generation: u64,
}

impl SchedulerState {
    fn new(mailbox: Scheduler, options: PoolOptions) -> Self {
        SchedulerState {
            idle: VecDeque::new(),
            busy: VecDeque::new(),
            timer_worker: None,
            // The global predates the client option; the Swift WebKit SDK
            // sets it for every client.
            retire_wasm_workers: options.worker_per_thread
                || js_sys::Reflect::get(
                    &js_sys::global(),
                    &JsValue::from_str("__wasmerWorkerPerThread"),
                )
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            retiring: BTreeSet::new(),
            stopping: BTreeMap::new(),
            retire_when_idle: BTreeSet::new(),
            ran_wasm: BTreeSet::new(),
            guest_memory_gc_budget: options.guest_memory_gc_budget,
            mailbox,
            pending_capi_transfers: BTreeMap::new(),
            capi_values: BTreeMap::new(),
            pending_capi_requests: BTreeMap::new(),
            capi_recipients: BTreeMap::new(),
            capi_origins: BTreeMap::new(),
            wasm_workers: BTreeMap::new(),
            doomed: BTreeMap::new(),
            next_doom_generation: 0,
            gates: BTreeMap::new(),
            deferred_wasm: VecDeque::new(),
            next_drain_generation: 0,
        }
    }

    /// Take an idle worker out of the pool and let it retire once its
    /// remaining jobs finish (see [`WorkerHandle::retire`]).
    fn retire_idle_worker(&mut self, worker_id: u32) {
        let Some(ix) = self.idle.iter().position(|worker| worker.id() == worker_id) else {
            return;
        };
        let worker = self.idle.remove(ix).unwrap();
        scheduler_diag(format!("retire idle worker={worker_id}"));
        worker.retire();
        self.stopping.insert(worker_id, worker);
    }

    /// The worker is gone: free its wasm-bindgen TLS block and stack.
    fn release_worker_memory(&mut self, worker_id: u32) {
        if let Some(gate) = self.gates.remove(&worker_id) {
            gate.release_thread_memory();
        }
    }

    /// Stop every worker without orphaning a runtime lock (wasmer-sdk#542).
    ///
    /// Each worker is asked to exit from its own message loop, where no SDK
    /// code is running on it. Workers that do not exit in time (blocked in a
    /// guest or a syscall) are force-terminated once they are outside the
    /// allocator.
    async fn shutdown(
        mut self,
        receiver: &mut UnboundedReceiver<SchedulerMessage>,
        close_completions: &mut Vec<tokio::sync::oneshot::Sender<()>>,
    ) {
        // Spawns still waiting for a draining worker never started: end their
        // processes instead of leaving joins pending.
        for deferred in self.deferred_wasm.drain(..) {
            deferred.task.process().terminate(1.into());
        }
        let mut workers: BTreeMap<u32, WorkerHandle> = BTreeMap::new();
        let stopping = std::mem::take(&mut self.stopping);
        let all = self
            .idle
            .drain(..)
            .chain(self.busy.drain(..))
            .chain(stopping.into_values())
            .chain(self.timer_worker.take());
        for worker in all {
            worker.shutdown();
            workers.insert(worker.id(), worker);
        }
        scheduler_diag(format!("shutdown workers={}", workers.len()));

        let mut deadline = Box::pin(GlobalScope::current().delay(SHUTDOWN_GRACE_MS));
        while !workers.is_empty() {
            let next = Box::pin(receiver.recv());
            let message = match futures::future::select(next, deadline).await {
                Either::Left((message, pending_deadline)) => {
                    deadline = pending_deadline;
                    message
                }
                Either::Right(_) => break,
            };
            match message {
                // A dedicated worker may retire on its own before it sees
                // the shutdown request; either way it has stopped.
                Some(
                    SchedulerMessage::WorkerExited { worker_id }
                    | SchedulerMessage::WorkerRetired { worker_id },
                ) => {
                    if let Some(worker) = workers.remove(&worker_id) {
                        worker.mark_exited();
                    }
                    self.release_worker_memory(worker_id);
                }
                Some(SchedulerMessage::Close {
                    completion: Some(completion),
                    ..
                }) => close_completions.push(completion),
                // Work submitted while closing is dropped with the pool.
                Some(_) => {}
                None => break,
            }
        }

        for worker in workers.into_values() {
            scheduler_diag(format!("shutdown force-terminates worker={}", worker.id()));
            worker.terminate_gated().await;
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
            SchedulerMessage::Timer(timer) => {
                if self.timer_worker.is_none() {
                    self.timer_worker = Some(self.start_worker(false)?);
                }
                self.timer_worker
                    .as_ref()
                    .unwrap()
                    .send_with_capi_transfers(PostMessagePayload::Timer(timer), Vec::new())
            }
            SchedulerMessage::Close { .. } | SchedulerMessage::WorkerFailed => {
                // Unreachable in practice: the receive loop breaks on Close
                // before calling execute(), and `shutdown()` stops every
                // worker.
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
            SchedulerMessage::FromWorker {
                source_worker_id,
                message,
            } => self.execute_from(Some(source_worker_id), *message),
            SchedulerMessage::SpawnWasm(task) => self.spawn_wasm(source_worker_id, task),
            SchedulerMessage::DrainWaitElapsed { generation } => {
                self.dispatch_deferred_wasm(Some(generation))
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
            SchedulerMessage::ForceTerminate {
                worker_id,
                generation,
            } => {
                if self.doomed.get(&worker_id) != Some(&generation) {
                    // The thread unwound on its own in the meantime.
                    return Ok(());
                }
                self.doomed.remove(&worker_id);
                let Some(worker) = self.remove_worker(worker_id) else {
                    return Ok(());
                };
                scheduler_diag(format!("force terminate worker={worker_id}"));
                wasm_bindgen_futures::spawn_local(async move {
                    worker.terminate_gated().await;
                });
                wasmer::js::collect_shared_objects();
                for worker in &self.idle {
                    worker.collect_shared_objects()?;
                }
                // A deferred spawn may have been waiting for this worker.
                self.dispatch_deferred_wasm(None)
            }
            SchedulerMessage::WorkerExited { worker_id } => {
                // Outside shutdown this is the exit of a force-terminated
                // worker, which was already removed from the pool. Node
                // reports it once the thread has stopped; browsers do not.
                tracing::trace!(worker.id = worker_id, "Worker exited");
                if let Some(worker) = self.stopping.remove(&worker_id) {
                    worker.mark_exited();
                }
                self.release_worker_memory(worker_id);
                Ok(())
            }
            SchedulerMessage::WorkerRetireRequested { worker_id } => {
                if self.idle.iter().any(|worker| worker.id() == worker_id) {
                    self.retire_idle_worker(worker_id);
                } else if self.busy.iter().any(|worker| worker.id() == worker_id)
                    && !self.retiring.contains(&worker_id)
                {
                    // It received a task after asking; stop routing work to
                    // it once that task is done.
                    self.retire_when_idle.insert(worker_id);
                }
                Ok(())
            }
            SchedulerMessage::WorkerIdle { worker_id } => {
                // The killed thread unwound on its own; keep the worker.
                self.doomed.remove(&worker_id);
                // A dedicated guest worker sends Retired after the JS promise
                // has settled and its SDK stack/TLS have been released.
                if self.retiring.contains(&worker_id) {
                    return Ok(());
                }
                move_worker(worker_id, &mut self.busy, &mut self.idle);
                let active_wasm_threads = self.wasm_workers.len();
                self.wasm_workers
                    .retain(|_, worker| worker.worker_id != worker_id);
                // Dropping the completed process can expire memories imported
                // by any worker. Idle workers otherwise retain those JS roots
                // until they happen to receive another task, and this worker
                // could not release its finished guest's memory.
                // Timer thunks also emit Idle; they must not broadcast a
                // collection to the entire pool on every network poll.
                let ran_wasm = self.ran_wasm.remove(&worker_id);
                if ran_wasm || self.wasm_workers.len() != active_wasm_threads {
                    wasmer::js::collect_shared_objects();
                    for worker in &self.idle {
                        worker.collect_shared_objects()?;
                    }
                }
                // After its collection message, so the worker drops the
                // finished guest's roots before it retires.
                if self.retire_when_idle.remove(&worker_id) {
                    self.retire_idle_worker(worker_id);
                }
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
                // After the collection above, so the worker drops the
                // finished guest's roots before it starts the next one.
                self.dispatch_deferred_wasm(None)
            }
            SchedulerMessage::WorkerRetired { worker_id } => {
                self.doomed.remove(&worker_id);
                if let Some(worker) = self.stopping.remove(&worker_id) {
                    worker.mark_exited();
                    self.release_worker_memory(worker_id);
                    return Ok(());
                }
                if !self.retiring.remove(&worker_id) {
                    if self.worker(worker_id).is_none() {
                        return Ok(());
                    }
                    anyhow::bail!("unexpected retired worker {worker_id}");
                }
                self.busy.retain(|worker| worker.id() != worker_id);
                self.ran_wasm.remove(&worker_id);
                self.wasm_workers
                    .retain(|_, worker| worker.worker_id != worker_id);
                self.release_worker_memory(worker_id);
                wasmer::js::collect_shared_objects();
                for worker in &self.idle {
                    worker.collect_shared_objects()?;
                }
                self.dispatch_deferred_wasm(None)
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

    fn post_message_from(
        &mut self,
        source_worker_id: Option<u32>,
        msg: PostMessagePayload,
    ) -> Result<(), Error> {
        let would_block = msg.would_block();
        let reason = match &msg {
            PostMessagePayload::Timer(_) => "timer",
            PostMessagePayload::Async(_) => "async",
            PostMessagePayload::Blocking(BlockingJob::Thunk(_)) => "blocking-thunk",
            PostMessagePayload::Blocking(BlockingJob::SpawnWasm(_)) => "blocking-wasm",
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

    /// Run a WASIX thread. When no worker is idle but a busy one has already
    /// finished its threads, wait for that worker instead of starting
    /// another (see [`DRAIN_WAIT_MS`]).
    fn spawn_wasm(&mut self, source_worker_id: Option<u32>, task: SpawnWasm) -> Result<(), Error> {
        if self.retire_wasm_workers
            || !self.idle.is_empty()
            || self.deferred_wasm.len() >= self.draining_workers()
        {
            return self.dispatch_wasm(source_worker_id, task);
        }
        self.next_drain_generation += 1;
        let generation = self.next_drain_generation;
        let (pid, tid) = task.task_key();
        scheduler_diag(format!("defer wasm={pid}.{tid} for a draining worker"));
        self.deferred_wasm.push_back(DeferredWasm {
            source_worker_id,
            task,
            generation,
        });
        let mailbox = self.mailbox.clone();
        let wait = drain_wait_ms();
        wasm_bindgen_futures::spawn_local(async move {
            GlobalScope::current().delay(wait).await;
            let _ = mailbox.send(SchedulerMessage::DrainWaitElapsed { generation });
        });
        Ok(())
    }

    fn dispatch_wasm(
        &mut self,
        source_worker_id: Option<u32>,
        task: SpawnWasm,
    ) -> Result<(), Error> {
        let task_key = task.task_key();
        let process = task.process();
        self.post_wasm_message_from(
            source_worker_id,
            PostMessagePayload::Blocking(BlockingJob::SpawnWasm(task)),
            task_key,
            process,
        )
    }

    /// Hand deferred spawns to idle workers, oldest first. A spawn starts a
    /// new worker instead when its wait ended with `elapsed` (or earlier), or
    /// when fewer draining workers are left than spawns waiting for them.
    fn dispatch_deferred_wasm(&mut self, elapsed: Option<u64>) -> Result<(), Error> {
        while let Some(front) = self.deferred_wasm.front() {
            let expired = elapsed.is_some_and(|generation| front.generation <= generation);
            let worth_waiting = self.deferred_wasm.len() <= self.draining_workers();
            if self.idle.is_empty() && !expired && worth_waiting {
                break;
            }
            let deferred = self.deferred_wasm.pop_front().unwrap();
            self.dispatch_wasm(deferred.source_worker_id, deferred.task)?;
        }
        Ok(())
    }

    /// Busy workers whose WASIX threads have all finished. Each reports Idle
    /// as soon as its task has unwound.
    fn draining_workers(&self) -> usize {
        self.busy
            .iter()
            .filter(|worker| {
                let id = worker.id();
                // A worker that asked to retire goes away instead of idle.
                if self.retiring.contains(&id)
                    || self.retire_when_idle.contains(&id)
                    || self.doomed.contains_key(&id)
                {
                    return false;
                }
                let mut tasks = self
                    .wasm_workers
                    .iter()
                    .filter(|(_, task)| task.worker_id == id)
                    .peekable();
                tasks.peek().is_some() && tasks.all(|(&(_, tid), task)| task.thread_finished(tid))
            })
            .count()
    }

    fn post_wasm_message_from(
        &mut self,
        source_worker_id: Option<u32>,
        msg: PostMessagePayload,
        task_key: (u32, u32),
        process: wasmer_wasix::WasiProcess,
    ) -> Result<(), Error> {
        let reason = format!("wasm-{}.{}", task_key.0, task_key.1);
        let worker = if self.retire_wasm_workers {
            let worker = self.start_worker(true)?;
            self.retiring.insert(worker.id());
            worker
        } else {
            self.next_available_worker(&reason)?
        };
        let transfers = self.take_capi_transfers(source_worker_id, true, Some(worker.id()));
        self.ran_wasm.insert(worker.id());
        self.wasm_workers.insert(
            task_key,
            WasmWorker {
                worker_id: worker.id(),
                process,
            },
        );
        worker
            .send_with_capi_transfers(msg, transfers)
            .with_context(|| format!("Unable to send a message to worker {}", worker.id()))?;
        self.busy.push_back(worker);
        Ok(())
    }

    fn next_available_worker(&mut self, reason: &str) -> Result<WorkerHandle, Error> {
        // Reuse the most recently available worker. Rotating through the idle
        // pool spreads short-lived guest memories across otherwise quiet JS
        // heaps, delaying reclamation of their shared backing reservations.
        if let Some(worker) = self.idle.pop_back() {
            tracing::trace!(
                worker.id = worker.id(),
                "Sending the message to an idle worker"
            );
            return Ok(worker);
        }

        // Rather than sending the task to one of the blocking workers,
        // let's spawn a new worker

        let worker = self.start_worker(false)?;
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

    fn start_worker(&mut self, retire_after_task: bool) -> Result<WorkerHandle, Error> {
        // Note: By using a monotonically incrementing counter, we can make sure
        // every single worker created with this shared linear memory will get a
        // unique ID.
        static NEXT_ID: AtomicU32 = AtomicU32::new(1);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        // A dedicated worker's isolate is disposed with its guest memory.
        let budget = if retire_after_task {
            0.0
        } else {
            self.guest_memory_gc_budget as f64
        };
        let handle = WorkerHandle::spawn(id, self.mailbox.clone(), retire_after_task, budget)?;
        self.gates.insert(id, handle.gate());

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

    /// Stop the worker running a killed WASIX thread.
    ///
    /// WASIX has already marked the thread terminated and woken its atomic
    /// waiters, so a thread blocked in a syscall unwinds and reports Idle on
    /// its own; that keeps the worker reusable and never interrupts SDK code.
    /// Only a guest that never calls into the runtime is still running when
    /// the grace period ends, and is then force-terminated.
    fn terminate_wasm_thread(&mut self, task_key: (u32, u32)) {
        let Some(worker) = self.wasm_workers.get(&task_key) else {
            return;
        };
        let worker_id = worker.worker_id;
        if self.doomed.contains_key(&worker_id) {
            return;
        }
        self.next_doom_generation += 1;
        let generation = self.next_doom_generation;
        self.doomed.insert(worker_id, generation);

        let mailbox = self.mailbox.clone();
        let grace = terminate_grace_ms();
        wasm_bindgen_futures::spawn_local(async move {
            GlobalScope::current().delay(grace).await;
            let _ = mailbox.send(SchedulerMessage::ForceTerminate {
                worker_id,
                generation,
            });
        });
    }

    /// Take a worker out of the pool along with everything routed to it.
    fn remove_worker(&mut self, worker_id: u32) -> Option<WorkerHandle> {
        self.retiring.remove(&worker_id);
        self.retire_when_idle.remove(&worker_id);
        self.ran_wasm.remove(&worker_id);
        self.wasm_workers
            .retain(|_, worker| worker.worker_id != worker_id);
        self.pending_capi_requests.retain(|_, workers| {
            workers.remove(&worker_id);
            !workers.is_empty()
        });
        for queue in [&mut self.busy, &mut self.idle] {
            if let Some(ix) = queue.iter().position(|worker| worker.id() == worker_id) {
                return queue.remove(ix);
            }
        }
        None
    }

    fn blocking_tasks_are_idle(&self) -> bool {
        // Guest PIDs/TIDs can repeat across sandboxes sharing this pool. The
        // process map can therefore be empty while another worker is still
        // unwinding; wait for every blocking worker's Idle/Retired message.
        self.busy.is_empty() && self.deferred_wasm.is_empty()
    }
}

fn terminate_grace_ms() -> i32 {
    js_sys::Reflect::get(
        &js_sys::global(),
        &JsValue::from_str("__wasmerTerminateGraceMs"),
    )
    .ok()
    .and_then(|value| value.as_f64())
    .filter(|ms| ms.is_finite() && *ms >= 0.0)
    .map(|ms| ms.min(i32::MAX as f64) as i32)
    .unwrap_or(TERMINATE_GRACE_MS)
}

fn drain_wait_ms() -> i32 {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("__wasmerDrainWaitMs"))
        .ok()
        .and_then(|value| value.as_f64())
        .filter(|ms| ms.is_finite() && *ms >= 0.0)
        .map(|ms| ms.min(i32::MAX as f64) as i32)
        .unwrap_or(DRAIN_WAIT_MS)
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
    use tokio::sync::oneshot;
    use wasm_bindgen::JsValue;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    async fn spawn_an_async_function() {
        let (sender, receiver) = oneshot::channel();
        let (tx, _) = mpsc::unbounded_channel();
        let tx = unsafe { Scheduler::new(tx, wasmer::js::current_thread_id()) };
        let mut scheduler = SchedulerState::new(tx, PoolOptions::default());
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
        let mut scheduler = SchedulerState::new(tx, PoolOptions::default());
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
}
