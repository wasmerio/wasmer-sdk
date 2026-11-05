use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
    future::poll_fn,
    io,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    task::{Poll, Waker},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasixv2::{Engine, Machine, Net, NetConfig, ProcessConfig, browser};
use wasixv2_abi::OpenFlags;
use wasixv2_host::{
    BrowserHost, ByteSink, Executor, Host, LocalFuture, ThreadStart, WindowSize,
    browser::BrowserExecutor,
};
use wasixv2_kernel::HostClock;
use wasixv2_vfs::{Cred, Ctx, File, LookupFlags, OpenHow, RenameMode, Vfs};

use super::driver::{Queue, Request};

type Reply = Result<(Value, Vec<u8>), String>;

enum Buffer {
    Uploading(Vec<u8>),
    Ready(bytes::Bytes),
}

struct Reservation {
    services: Arc<Services>,
    used: bool,
    released: bool,
}

// This wrapper counts only the audited per-Machine kernel timer/console
// ThreadStarts, delegating their actual ownership to B2's service admissions.
struct Services {
    queue: Arc<Queue>,
    executor: BrowserExecutor,
    machine: u32,
    tokens: Mutex<Vec<u32>>,
}

static NEXT_SERVICE: AtomicU32 = AtomicU32::new(1);

impl Executor for Services {
    fn spawn_local(&self, future: LocalFuture<'static, ()>) {
        self.executor.spawn_local(future);
    }
    fn spawn_thread(&self, start: ThreadStart) -> io::Result<()> {
        let token = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
        assert!(token != 0, "SDK service identity exhausted");
        {
            let mut tokens = self.tokens.lock().unwrap();
            assert!(tokens.len() < 2, "unbudgeted SDK Machine service");
            // Register before admission: close owns not-yet-started services too.
            tokens.push(token);
        }
        let queue = self.queue.clone();
        let machine = self.machine;
        self.executor.spawn_thread(Box::new(move || {
            Box::pin(async move {
                start().await;
                queue.event(
                    "service_finished",
                    json!({"machine":machine,"token":token}),
                    &[],
                );
            })
        }))
    }
    fn spawn_blocking(&self, work: Box<dyn FnOnce() + Send>) -> LocalFuture<'static, ()> {
        let state = Arc::new(Mutex::new((false, None::<Waker>)));
        let output = state.clone();
        self.spawn_thread(Box::new(move || {
            Box::pin(async move {
                work();
                let wake = {
                    let mut state = output.lock().unwrap();
                    state.0 = true;
                    state.1.take()
                };
                if let Some(wake) = wake {
                    wake.wake();
                }
            })
        }))
        .expect("SDK blocking service admission failed");
        Box::pin(poll_fn(move |cx| {
            let mut state = state.lock().unwrap();
            if state.0 {
                Poll::Ready(())
            } else {
                state.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }))
    }
}

struct MachineHost {
    host: Arc<BrowserHost>,
    services: Arc<Services>,
}
impl Host for MachineHost {
    fn realtime(&self) -> Duration {
        self.host.realtime()
    }
    fn monotonic(&self) -> Duration {
        self.host.monotonic()
    }
    fn random(&self, bytes: &mut [u8]) {
        self.host.random(bytes);
    }
    fn sleep(&self, duration: Duration) -> LocalFuture<'_, ()> {
        self.host.sleep(duration)
    }
    fn sleep_until(&self, deadline: Duration) -> LocalFuture<'_, ()> {
        self.host.sleep_until(deadline)
    }
    fn sleep_until_range(&self, deadline: Duration, slack: Duration) -> LocalFuture<'_, ()> {
        self.host.sleep_until_range(deadline, slack)
    }
    fn executor(&self) -> &dyn Executor {
        &*self.services
    }
    fn report(&self, message: &str) {
        self.host.report(message);
    }
}

struct Live {
    machine: Arc<Machine>,
    run: browser::Run,
    session: Arc<browser::Session>,
}

// Close owns a launch from before its first await until it publishes a Process
// or genuinely tears down. A completed marker does not retain the Machine.
struct Launch {
    live: RefCell<Option<(Arc<Machine>, Arc<browser::Session>)>>,
    canceled: Cell<bool>,
    done: Cell<bool>,
    waiters: RefCell<Vec<Waker>>,
}

impl Launch {
    fn cancel(&self) {
        self.canceled.set(true);
        if let Some((machine, session)) = self.live.borrow().as_ref() {
            session.abort();
            let _ = machine.signal(9);
        }
    }

    async fn wait(&self) {
        poll_fn(|cx| {
            if self.done.get() {
                Poll::Ready(())
            } else {
                let mut waiters = self.waiters.borrow_mut();
                if !waiters.iter().any(|w| w.will_wake(cx.waker())) {
                    waiters.push(cx.waker().clone());
                }
                Poll::Pending
            }
        })
        .await
    }

    fn finish(&self) {
        self.done.set(true);
        for waiter in self.waiters.borrow_mut().drain(..) {
            waiter.wake();
        }
    }
}

struct Process {
    live: RefCell<Option<Rc<Live>>>,
    input: Arc<wasixv2_stdio_web::Sink>,
    output: [Arc<wasixv2_stdio_web::Source>; 2],
    reading: [Cell<bool>; 2],
    writing: Cell<bool>,
    result: RefCell<Option<Result<i32, String>>>,
    waiters: RefCell<Vec<Waker>>,
    closing: Cell<bool>,
}

impl Process {
    async fn wait(&self) -> Result<i32, String> {
        poll_fn(|cx| {
            if let Some(result) = self.result.borrow().clone() {
                return Poll::Ready(result);
            }
            let mut waiters = self.waiters.borrow_mut();
            if !waiters.iter().any(|w| w.will_wake(cx.waker())) {
                waiters.push(cx.waker().clone());
            }
            Poll::Pending
        })
        .await
    }
    fn abort_io(&self) {
        self.closing.set(true);
        self.input.abort();
        for output in &self.output {
            output.cancel();
        }
        if let Some(live) = self.live.borrow().as_ref() {
            live.session.abort();
        }
    }
}

pub(crate) struct Resources {
    queue: Arc<Queue>,
    executor: BrowserExecutor,
    host: Arc<BrowserHost>,
    machine_limit: usize,
    next: u32,
    buffers: HashMap<u32, Buffer>,
    directories: HashMap<u32, Arc<browser::WebFs>>,
    files: HashMap<u32, Arc<File>>,
    packages: HashMap<u32, Arc<crate::package::Package>>,
    reservations: HashMap<u32, Reservation>,
    processes: HashMap<u32, Rc<Process>>,
    launches: HashMap<u32, Rc<Launch>>,
    closing: bool,
    closed: bool,
}

impl Resources {
    pub(crate) fn new(queue: Arc<Queue>, executor: BrowserExecutor, machine_limit: usize) -> Self {
        Self {
            queue,
            host: Arc::new(
                BrowserHost::new(executor.clone()).expect("SDK timer driver unavailable"),
            ),
            executor,
            machine_limit,
            next: 1,
            buffers: HashMap::new(),
            directories: HashMap::new(),
            files: HashMap::new(),
            packages: HashMap::new(),
            reservations: HashMap::new(),
            processes: HashMap::new(),
            launches: HashMap::new(),
            closing: false,
            closed: false,
        }
    }
    pub(crate) fn closed(&self) -> bool {
        self.closed && self.reservations.is_empty() && self.launches.is_empty()
    }
    fn id(&mut self) -> Result<u32, String> {
        let id = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or("SDK object identity exhausted")?;
        Ok(id)
    }
    pub(crate) fn store_error(&mut self, error: String) -> Value {
        // JSON escaping can expand a string sixfold. Stream larger diagnostics
        // through the ordinary owned-buffer path, preserving their complete text.
        if error.len() <= 8192 {
            return Value::String(error);
        }
        let id = match self.id() {
            Ok(id) => id,
            Err(error) => return Value::String(error),
        };
        let bytes: bytes::Bytes = error.into_bytes().into();
        let size = bytes.len();
        self.buffers.insert(id, Buffer::Ready(bytes));
        json!({"buffer":id,"size":size})
    }
    fn buffer(&self, id: u32) -> Result<wasixv2::OwnedBuffer, String> {
        match self.buffers.get(&id) {
            Some(Buffer::Ready(bytes)) => Ok(wasixv2::OwnedBuffer::from_bytes(bytes.clone())),
            _ => Err("unknown SDK sealed buffer".into()),
        }
    }
    fn process(&self, id: u32) -> Result<Rc<Process>, String> {
        self.processes
            .get(&id)
            .cloned()
            .ok_or_else(|| "unknown SDK process".into())
    }
    fn release(&mut self, id: u32) {
        let reservation = self
            .reservations
            .get_mut(&id)
            .expect("live SDK Machine reservation");
        assert!(!reservation.released);
        reservation.released = true;
        self.queue.event(
            "machine_released",
            json!({"machine":id,"tokens":reservation.services.tokens.lock().unwrap().clone()}),
            &[],
        );
    }
}

fn number(value: &Value, field: &str) -> Result<u32, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| format!("invalid SDK {field}"))
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("invalid SDK {field}"))
}
fn done(value: Value) -> Reply {
    Ok((value, Vec::new()))
}
fn error(value: impl std::fmt::Debug) -> String {
    format!("{value:?}")
}

pub(crate) async fn execute(owner: Rc<RefCell<Resources>>, request: Request) -> Reply {
    let Request {
        operation,
        handle,
        metadata,
        bytes,
        ..
    } = request;
    if owner.borrow().closing
        && !matches!(
            operation.as_str(),
            "close"
                | "release_machine"
                | "abandon_machine"
                | "kill"
                | "signal"
                | "resize"
                | "hangup"
                | "close_input"
                | "abort_input"
                | "cancel_output"
                | "wait"
        )
    {
        return Err("SDK client is closing".into());
    }
    match operation.as_str() {
        "package_create" | "package_load" | "package_binary" => {
            package_operation(owner, &operation, handle, metadata).await
        }
        "buffer_new" => {
            let mut state = owner.borrow_mut();
            let id = state.id()?;
            state.buffers.insert(id, Buffer::Uploading(Vec::new()));
            done(json!(id))
        }
        "buffer_append" => {
            let mut state = owner.borrow_mut();
            let Buffer::Uploading(buffer) = state
                .buffers
                .get_mut(&handle)
                .ok_or("unknown SDK byte buffer")?
            else {
                return Err("SDK byte buffer is sealed".into());
            };
            buffer.try_reserve(bytes.len()).map_err(error)?;
            buffer.extend_from_slice(&bytes);
            done(Value::Null)
        }
        "buffer_seal" => {
            let mut state = owner.borrow_mut();
            let buffer = state
                .buffers
                .remove(&handle)
                .ok_or("unknown SDK byte buffer")?;
            let buffer = match buffer {
                Buffer::Uploading(bytes) => Buffer::Ready(bytes.into()),
                ready => ready,
            };
            state.buffers.insert(handle, buffer);
            done(Value::Null)
        }
        "buffer_drop" => {
            owner.borrow_mut().buffers.remove(&handle);
            done(Value::Null)
        }
        "buffer_read" => {
            let buffer = {
                let state = owner.borrow();
                let Some(Buffer::Ready(buffer)) = state.buffers.get(&handle) else {
                    return Err("unknown SDK sealed buffer".into());
                };
                buffer.clone()
            };
            let offset = metadata
                .get("offset")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or("invalid SDK buffer offset")?;
            if offset > buffer.len() {
                return Err("SDK buffer offset is past its end".into());
            }
            let end = buffer.len().min(offset.saturating_add(65536));
            Ok((json!(end - offset), buffer[offset..end].to_vec()))
        }
        "directory_new" => {
            let host = owner.borrow().host.clone();
            let directory = browser::directory(Arc::new(HostClock(host)), 0o755, 0, 0)
                .await
                .map_err(error)?;
            let mut state = owner.borrow_mut();
            let id = state.id()?;
            state.directories.insert(id, directory);
            done(json!(id))
        }
        "file_open" | "mkdir" | "rename" => filesystem(owner, &operation, handle, metadata).await,
        "file_read" | "file_write" => {
            let file = owner
                .borrow()
                .files
                .get(&handle)
                .cloned()
                .ok_or("unknown SDK file")?;
            let offset = metadata
                .get("offset")
                .and_then(Value::as_u64)
                .ok_or("invalid SDK file offset")?;
            if operation == "file_write" {
                done(json!(file.write_at(&bytes, offset).await.map_err(error)?))
            } else {
                let mut output = vec![0; 65536];
                let count = file.read_at(&mut output, offset).await.map_err(error)?;
                output.truncate(count);
                Ok((json!(count), output))
            }
        }
        "file_close" => {
            owner.borrow_mut().files.remove(&handle);
            done(Value::Null)
        }
        "reserve_machine" => {
            let mut state = owner.borrow_mut();
            if state.reservations.len() >= state.machine_limit {
                return Err("SDK live Machine capacity is full".into());
            }
            let id = state.id()?;
            let services = Arc::new(Services {
                queue: state.queue.clone(),
                executor: state.executor.services(),
                machine: id,
                tokens: Mutex::new(Vec::new()),
            });
            state.reservations.insert(
                id,
                Reservation {
                    services,
                    used: false,
                    released: false,
                },
            );
            done(json!(id))
        }
        "release_machine" => {
            let mut state = owner.borrow_mut();
            if !state.reservations.get(&handle).is_some_and(|r| r.released) {
                return Err("SDK Machine has not released its resources".into());
            }
            state.reservations.remove(&handle);
            done(Value::Null)
        }
        "abandon_machine" => {
            let mut state = owner.borrow_mut();
            if state
                .reservations
                .get(&handle)
                .is_some_and(|r| !r.used && !r.released)
            {
                state.release(handle);
            }
            done(Value::Null)
        }
        "spawn" => spawn(owner, handle, metadata).await,
        "write_input" => {
            let process = owner.borrow().process(handle)?;
            let _lane = Lane::enter(&process.writing)?;
            done(json!(process.input.write(&bytes).await.map_err(error)?))
        }
        "close_input" => {
            owner.borrow().process(handle)?.input.close();
            done(Value::Null)
        }
        "abort_input" => {
            owner.borrow().process(handle)?.input.abort();
            done(Value::Null)
        }
        "read_output" => {
            let process = owner.borrow().process(handle)?;
            let index = output_index(&metadata)?;
            let _lane = Lane::enter(&process.reading[index])?;
            let max = number(&metadata, "max")?;
            if max == 0 || max > 65536 {
                return Err("invalid SDK output frame size".into());
            }
            let mut bytes = vec![0; max as usize];
            let count = process.output[index]
                .read(&mut bytes)
                .await
                .map_err(error)?;
            bytes.truncate(count);
            Ok((json!(count), bytes))
        }
        "cancel_output" => {
            owner.borrow().process(handle)?.output[output_index(&metadata)?].cancel();
            done(Value::Null)
        }
        "kill" | "signal" | "resize" | "hangup" => {
            let process = owner.borrow().process(handle)?;
            let live = process.live.borrow().clone();
            if let Some(live) = live {
                if operation == "resize" {
                    let rows = u16::try_from(number(&metadata, "rows")?).map_err(error)?;
                    let cols = u16::try_from(number(&metadata, "cols")?).map_err(error)?;
                    live.run.signaller().console_resize(WindowSize {
                        rows,
                        cols,
                        ..Default::default()
                    });
                } else if operation == "hangup" {
                    live.run.signaller().console_hangup();
                } else {
                    live.machine
                        .signal(if operation == "kill" {
                            9
                        } else {
                            number(&metadata, "signal")? as i32
                        })
                        .map_err(error)?;
                }
            }
            done(Value::Null)
        }
        "wait" => {
            let process = owner.borrow().process(handle)?;
            done(json!(process.wait().await?))
        }
        "close" => {
            let (processes, launches) = {
                let mut state = owner.borrow_mut();
                state.closing = true;
                (
                    state.processes.values().cloned().collect::<Vec<_>>(),
                    state.launches.values().cloned().collect::<Vec<_>>(),
                )
            };
            // Abort unread output and capacity-blocked input before waiting for
            // genuine kernel completion. Keep this driver accepting controls.
            for process in &processes {
                process.abort_io();
                if let Some(live) = process.live.borrow().as_ref() {
                    let _ = live.machine.signal(9);
                }
            }
            for launch in &launches {
                launch.cancel();
            }
            for launch in launches {
                launch.wait().await;
            }
            for process in processes {
                // Guest errors belong to Process.wait. They cannot interrupt
                // teardown of another process or leave the driver admitted.
                let _ = process.wait().await;
            }
            let mut state = owner.borrow_mut();
            state.files.clear();
            state.buffers.clear();
            state.directories.clear();
            state.packages.clear();
            // Retain completed handles until the driver drops Resources, so
            // already-admitted kill/control requests remain idempotent.
            // Unused reservations never constructed a Machine or service.
            let unused = state
                .reservations
                .iter()
                .filter_map(|(id, r)| (!r.used && !r.released).then_some(*id))
                .collect::<Vec<_>>();
            for id in unused {
                state.release(id);
            }
            state.closed = true;
            done(Value::Null)
        }
        _ => Err(format!("unknown SDK operation {operation}")),
    }
}

struct Lane<'a>(&'a Cell<bool>);
impl<'a> Lane<'a> {
    fn enter(lane: &'a Cell<bool>) -> Result<Self, String> {
        if lane.replace(true) {
            return Err("SDK stream operation already pending".into());
        }
        Ok(Self(lane))
    }
}
impl Drop for Lane<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
fn output_index(metadata: &Value) -> Result<usize, String> {
    match text(metadata, "stream")? {
        "stdout" => Ok(0),
        "stderr" => Ok(1),
        _ => Err("invalid SDK output stream".into()),
    }
}

async fn filesystem(
    owner: Rc<RefCell<Resources>>,
    operation: &str,
    handle: u32,
    metadata: Value,
) -> Reply {
    let directory = owner
        .borrow()
        .directories
        .get(&handle)
        .cloned()
        .ok_or("unknown SDK directory")?;
    let vfs = Vfs::new(directory);
    let root = vfs.root();
    let cred = Cred::root();
    let cx = Ctx {
        cred: &cred,
        root: &root,
        umask: 0o022,
        task: 0,
        leases: None,
    };
    let path = text(&metadata, "path")?;
    match operation {
        "file_open" => {
            let write = metadata
                .get("write")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if write && let Some((parent, _)) = path.rsplit_once('/') {
                vfs.mkdir_all(&cx, parent.as_bytes()).await.map_err(error)?;
            }
            let file = vfs
                .open(
                    &cx,
                    &root,
                    path.as_bytes(),
                    &OpenHow {
                        flags: if write {
                            OpenFlags::O_WRONLY | OpenFlags::O_CREAT | OpenFlags::O_TRUNC
                        } else {
                            OpenFlags::O_RDONLY
                        },
                        mode: 0o644,
                        lookup: LookupFlags::follow(),
                    },
                )
                .await
                .map_err(error)?;
            let mut state = owner.borrow_mut();
            let id = state.id()?;
            state.files.insert(id, Arc::new(file));
            done(json!(id))
        }
        "mkdir" => {
            if metadata
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                vfs.mkdir_all(&cx, path.as_bytes()).await.map_err(error)?;
            } else {
                vfs.mkdir(&cx, &root, path.as_bytes(), 0o755)
                    .await
                    .map_err(error)?;
            }
            done(Value::Null)
        }
        "rename" => {
            vfs.rename(
                &cx,
                &root,
                path.as_bytes(),
                &root,
                text(&metadata, "to")?.as_bytes(),
                RenameMode::Replace,
            )
            .await
            .map_err(error)?;
            done(Value::Null)
        }
        _ => unreachable!(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spawn {
    buffer: u32,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    mounts: Vec<(String, u32)>,
    terminal: Option<[u16; 2]>,
}

async fn spawn(owner: Rc<RefCell<Resources>>, reservation: u32, metadata: Value) -> Reply {
    let config = {
        let state = owner.borrow();
        let Some(Buffer::Ready(bytes)) = state.buffers.get(&number(&metadata, "config")?) else {
            return Err("SDK spawn configuration is not sealed".into());
        };
        serde_json::from_slice::<Spawn>(bytes).map_err(error)?
    };
    let (id, bytes, host, executor, mounts) = {
        let mut state = owner.borrow_mut();
        let Some(Buffer::Ready(bytes)) = state.buffers.get(&config.buffer) else {
            return Err("SDK module buffer is not sealed".into());
        };
        let bytes = bytes.clone();
        let mounts = config
            .mounts
            .iter()
            .map(|(path, id)| {
                state
                    .directories
                    .get(id)
                    .cloned()
                    .map(|fs| (path.clone(), fs))
                    .ok_or_else(|| "unknown SDK mount".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let id = state.id()?;
        let slot = state
            .reservations
            .get_mut(&reservation)
            .ok_or("no SDK Machine reservation")?;
        if slot.used {
            return Err("SDK Machine reservation already used".into());
        }
        slot.used = true;
        let services = slot.services.clone();
        (
            id,
            bytes,
            Arc::new(MachineHost {
                host: state.host.clone(),
                services,
            }),
            state.executor.clone(),
            mounts,
        )
    };
    let (session, stdio, streams) = match browser::Session::new(65536) {
        Ok(streams) => streams,
        Err(error) => {
            owner.borrow_mut().release(reservation);
            return Err(error.to_string());
        }
    };
    let session = Arc::new(session);
    let mut builder =
        browser::builder(host, executor.clone(), Net::new(NetConfig::default(), None));
    if let Some([cols, rows]) = config.terminal {
        builder = builder.console(
            session.console(WindowSize {
                cols,
                rows,
                ..Default::default()
            }),
            [true, true, false],
        );
    }
    let mut machine = builder.build();
    if let Some(cwd) = config.cwd {
        machine.set_working_dir(cwd);
    }
    let machine = Arc::new(machine);
    let launch = Rc::new(Launch {
        live: RefCell::new(Some((machine.clone(), session.clone()))),
        canceled: Cell::new(false),
        done: Cell::new(false),
        waiters: RefCell::new(Vec::new()),
    });
    owner
        .borrow_mut()
        .launches
        .insert(reservation, launch.clone());
    let result = async {
        for (path, fs) in mounts {
            machine.mount(&path, fs, false).await.map_err(error)?;
            if launch.canceled.get() {
                return Err("SDK client is closing".into());
            }
        }
        if launch.canceled.get() {
            return Err("SDK client is closing".into());
        }
        let bytes = wat::parse_bytes(&bytes).map_err(error)?;
        let engine = Engine::default();
        let module = wasixv2::load(&engine, &bytes).map_err(error)?;
        let run = browser::spawn(
            machine.clone(),
            &executor,
            engine,
            module,
            ProcessConfig {
                args: config.args,
                env: config.env,
                stdio,
            },
        )
        .await
        .map_err(error)?;
        // machine.start may yield before publishing its task. A close that
        // signaled an empty Machine must still kill that newly admitted run.
        let closing = owner.borrow().closing;
        if launch.canceled.get() || closing {
            machine.shutdown().await;
            drop(run);
            return Err("SDK client is closing".into());
        }
        Ok(run)
    }
    .await;
    let run = match result {
        Ok(run) => run,
        Err(error) => {
            machine.shutdown().await;
            session.abort();
            drop(machine);
            drop(session);
            finish_launch(&owner, reservation, &launch, true);
            return Err(error);
        }
    };
    let pid = run.id();
    let live = Rc::new(Live {
        machine,
        run,
        session,
    });
    let process = Rc::new(Process {
        live: RefCell::new(Some(live.clone())),
        input: streams.stdin,
        output: [streams.stdout, streams.stderr],
        reading: [Cell::new(false), Cell::new(false)],
        writing: Cell::new(false),
        result: RefCell::new(None),
        waiters: RefCell::new(Vec::new()),
        closing: Cell::new(false),
    });
    {
        let mut state = owner.borrow_mut();
        state.processes.insert(id, process.clone());
    }
    finish_launch(&owner, reservation, &launch, false);
    executor.spawn_local(Box::pin(async move {
        let result = live.run.wait().await;
        live.machine.shutdown().await;
        let finish = live.session.finish().await.map_err(error);
        process.live.borrow_mut().take();
        drop(live);
        owner.borrow_mut().release(reservation);
        let result = if process.closing.get() {
            result
        } else {
            result.and_then(|code| finish.map(|()| code))
        };
        *process.result.borrow_mut() = Some(result);
        for waiter in process.waiters.borrow_mut().drain(..) {
            waiter.wake();
        }
    }));
    done(json!({"handle":id,"pid":pid}))
}

fn finish_launch(
    owner: &Rc<RefCell<Resources>>,
    reservation: u32,
    launch: &Launch,
    released: bool,
) {
    // Drop provisional ownership before reporting resource release; close's
    // retained completion marker never keeps a timer/TTY Machine alive.
    launch.live.borrow_mut().take();
    {
        let mut state = owner.borrow_mut();
        state.launches.remove(&reservation);
        if released {
            state.release(reservation);
        }
    }
    launch.finish();
}

#[derive(Deserialize)]
struct DefinitionHandles {
    modules: BTreeMap<String, u32>,
    commands: BTreeMap<String, crate::package::CommandDefinition>,
    entrypoint: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, u32>,
}

#[derive(Deserialize)]
struct ArchiveHandles {
    buffer: u32,
    #[serde(default)]
    dependencies: BTreeMap<String, u32>,
}

async fn package_operation(
    owner: Rc<RefCell<Resources>>,
    operation: &str,
    handle: u32,
    metadata: Value,
) -> Reply {
    use crate::package::{Archive, DefinitionInput, Package, PackageError};
    let result: crate::package::Result<Value> = async {
        let metadata = if let Some(config) = metadata.get("config") {
            let config = config
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or_else(|| PackageError {
                    code: "INVALID_ARGUMENT",
                    message: "invalid package configuration".into(),
                })?;
            let bytes = owner.borrow().buffer(config).map_err(PackageError::load)?;
            serde_json::from_slice(&bytes).map_err(|e| PackageError {
                code: "INVALID_ARGUMENT",
                message: e.to_string(),
            })?
        } else {
            metadata
        };
        if operation == "package_binary" {
            let name = text(&metadata, "command").map_err(PackageError::load)?;
            let package = owner
                .borrow()
                .packages
                .get(&handle)
                .cloned()
                .ok_or_else(|| PackageError::load("unknown SDK package"))?;
            let bytes = package.binary(name)?;
            let hash = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let mut state = owner.borrow_mut();
            let id = state.id().map_err(PackageError::load)?;
            state.buffers.insert(id, Buffer::Ready(bytes.into_bytes()));
            return Ok(json!({"buffer":id,"hash":hash}));
        }
        let clock = Arc::new(HostClock(owner.borrow().host.clone()));
        let package = if operation == "package_create" {
            let config: DefinitionHandles =
                serde_json::from_value(metadata).map_err(|e| PackageError {
                    code: "INVALID_ARGUMENT",
                    message: e.to_string(),
                })?;
            let (modules, files) = {
                let state = owner.borrow();
                let read = |items: BTreeMap<String, u32>| {
                    items
                        .into_iter()
                        .map(|(name, id)| {
                            state
                                .buffer(id)
                                .map(|bytes| (name, bytes))
                                .map_err(PackageError::load)
                        })
                        .collect::<crate::package::Result<BTreeMap<_, _>>>()
                };
                (read(config.modules)?, read(config.files)?)
            };
            DefinitionInput {
                modules,
                commands: config.commands,
                entrypoint: config.entrypoint,
                files,
            }
            .materialize(clock)
            .await?
        } else {
            let config: ArchiveHandles =
                serde_json::from_value(metadata).map_err(PackageError::load)?;
            let bytes = owner
                .borrow()
                .buffer(config.buffer)
                .map_err(PackageError::load)?;
            if bytes.starts_with(b"\0asm") {
                if !config.dependencies.is_empty() {
                    return Err(PackageError::load(
                        "raw module sources do not declare WEBC dependency aliases",
                    ));
                }
                DefinitionInput::raw(bytes).materialize(clock).await?
            } else {
                let dependencies = {
                    let state = owner.borrow();
                    config
                        .dependencies
                        .into_iter()
                        .map(
                            |(alias, id)| match state.packages.get(&id).map(Arc::as_ref) {
                                Some(Package::Webc(package)) => Ok((alias, package.clone())),
                                _ => Err(PackageError::load(
                                    "supplied WEBC dependency is not an archive package",
                                )),
                            },
                        )
                        .collect::<crate::package::Result<BTreeMap<_, _>>>()?
                };
                Package::Webc(Arc::new(Archive::from_bytes(bytes, dependencies)?))
            }
        };
        let mut state = owner.borrow_mut();
        if state.closing {
            return Err(PackageError {
                code: "CLIENT_CLOSED",
                message: "SDK client is closing".into(),
            });
        }
        let id = state.id().map_err(PackageError::load)?;
        let mut metadata = serde_json::to_value(package.metadata()).map_err(PackageError::load)?;
        metadata
            .as_object_mut()
            .expect("package metadata object")
            .insert("handle".into(), json!(id));
        state.packages.insert(id, Arc::new(package));
        Ok(metadata)
    }
    .await;
    // All package metadata/diagnostics use the existing owned-buffer channel,
    // so command lists and source names cannot widen the root/event frame.
    let payload = match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let bytes = serde_json::to_vec(&payload).map_err(error)?;
    let mut state = owner.borrow_mut();
    let id = state.id()?;
    state.buffers.insert(id, Buffer::Ready(bytes.into()));
    done(json!({"payload":id}))
}
