use std::{
    cell::RefCell,
    collections::{HashSet, VecDeque},
    future::poll_fn,
    rc::Rc,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
};

use futures_util::{Stream, future::LocalBoxFuture, stream::FuturesUnordered};
use serde::Serialize;
use serde_json::Value;
use wasixv2_host::{Executor, browser::BrowserExecutor};
use wasm_bindgen::prelude::*;

// Transport limits bound queued frames and operations, not the size of an owned
// package or file. Large data is transferred using multiple bounded frames.
const FRAME_BYTES: usize = 64 * 1024;
const DATA_OPERATIONS: usize = 128;
const CONTROL_OPERATIONS: usize = 32;
const POLL_BUDGET: usize = 16;

pub(crate) struct Request {
    pub id: u32,
    pub operation: String,
    pub handle: u32,
    pub metadata: Value,
    pub bytes: Vec<u8>,
    control: bool,
}

#[derive(Default)]
struct Pending {
    controls: VecDeque<Request>,
    data: VecDeque<Request>,
    ids: HashSet<u32>,
    data_count: usize,
    control_count: usize,
    kill_count: usize,
    close_pending: bool,
    waker: Option<Waker>,
    closing: bool,
    closed: bool,
}

pub(crate) struct Queue {
    generation: u32,
    machine_limit: usize,
    pending: Mutex<Pending>,
}

impl Queue {
    fn submit(&self, request: Request) -> Result<bool, JsValue> {
        let wake = {
            let mut pending = self.pending.lock().unwrap();
            if pending.closed {
                // A stale page control may race the final closed event. It
                // cannot reopen the heap or turn normal close into a fatal.
                return Ok(false);
            }
            if pending.ids.contains(&request.id) {
                return Err(JsValue::from_str("duplicate SDK operation identity"));
            }
            if pending.closing && !request.control {
                return Ok(false);
            }
            if request.operation == "close" && pending.closing {
                return Err(JsValue::from_str("SDK close is already pending"));
            }
            // Ordinary controls cannot consume the per-Machine kill slots or
            // the single close slot. Both sides use this same bounded budget.
            let full = if request.operation == "close" {
                false
            } else if request.operation == "kill" {
                pending.kill_count >= self.machine_limit
            } else if request.control {
                pending.control_count - pending.kill_count - usize::from(pending.close_pending)
                    >= CONTROL_OPERATIONS
            } else {
                pending.data_count >= DATA_OPERATIONS
            };
            if full {
                return Ok(false);
            }
            pending.ids.insert(request.id);
            if request.control {
                if request.operation == "close" {
                    pending.closing = true;
                    pending.close_pending = true;
                } else if request.operation == "kill" {
                    pending.kill_count += 1;
                }
                pending.control_count += 1;
                if request.operation == "close" {
                    pending.controls.push_front(request);
                } else {
                    pending.controls.push_back(request);
                }
            } else {
                pending.data_count += 1;
                pending.data.push_back(request);
            }
            pending.waker.clone()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
        Ok(true)
    }

    fn complete(&self, id: u32, control: bool, operation: &str) {
        {
            let mut pending = self.pending.lock().unwrap();
            assert!(pending.ids.remove(&id));
            if control {
                pending.control_count -= 1;
                if operation == "kill" {
                    pending.kill_count -= 1;
                } else if operation == "close" {
                    pending.close_pending = false;
                }
            } else {
                pending.data_count -= 1;
            }
        }
        self.event("capacity", Value::Null, &[]);
    }

    pub(crate) fn event(&self, kind: &str, value: Value, bytes: &[u8]) {
        assert!(bytes.len() <= FRAME_BYTES);
        assert!(value.to_string().len() <= FRAME_BYTES);
        #[derive(Serialize)]
        struct Event<'a> {
            sdk: bool,
            generation: u32,
            kind: &'a str,
            value: Value,
        }
        let event = Event {
            sdk: true,
            generation: self.generation,
            kind,
            value,
        }
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .expect("SDK event serialization failed");
        js_sys::Reflect::set(
            &event,
            &JsValue::from_str("bytes"),
            &js_sys::Uint8Array::from(bytes).into(),
        )
        .expect("SDK event bytes failed");
        wasixv2_host::browser::emit_event(event).expect("SDK completion transfer failed");
    }
}

thread_local! {
    // This registry belongs to the root worker; no JS handles cross the heap.
    static ROOT: RefCell<Option<Arc<Queue>>> = const { RefCell::new(None) };
}

#[wasm_bindgen]
pub fn sdk_open(generation: u32, task_limit: u32, machine_limit: u32) -> Result<(), JsValue> {
    if generation == 0 || machine_limit == 0 || machine_limit > task_limit || machine_limit > 64 {
        return Err(JsValue::from_str("invalid bounded SDK worker capacity"));
    }
    ROOT.with_borrow(|root| {
        if root.is_some() {
            return Err(JsValue::from_str("SDK heap already has an owner"));
        }
        Ok(())
    })?;
    // One long-lived SDK driver plus two reserved services per private Machine:
    // the kernel timer driver and optional console pump. The JS bootstrap uses
    // this same expression. Networking services require their own later budget.
    let executor = BrowserExecutor::new(task_limit as usize, 1 + 2 * machine_limit as usize)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let queue = Arc::new(Queue {
        generation,
        machine_limit: machine_limit as usize,
        pending: Mutex::new(Pending::default()),
    });
    let driver_queue = queue.clone();
    let driver_executor = executor.clone();
    executor
        .services()
        .spawn_thread(Box::new(move || {
            Box::pin(drive(driver_queue, driver_executor, machine_limit as usize))
        }))
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    ROOT.with_borrow_mut(|root| *root = Some(queue));
    Ok(())
}

#[wasm_bindgen]
pub fn sdk_submit(
    id: u32,
    operation: String,
    handle: u32,
    metadata: &str,
    bytes: &[u8],
) -> Result<bool, JsValue> {
    if id == 0 || operation.len() > 64 || bytes.len() > FRAME_BYTES || metadata.len() > FRAME_BYTES
    {
        return Err(JsValue::from_str("invalid SDK transport frame"));
    }
    // The producer cannot classify arbitrary data as control to consume the
    // reserved kill/close capacity. Control carries no payload.
    let control = matches!(
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
    );
    if control && !bytes.is_empty() {
        return Err(JsValue::from_str(
            "SDK control cannot contain payload bytes",
        ));
    }
    let metadata =
        serde_json::from_str(metadata).map_err(|error| JsValue::from_str(&error.to_string()))?;
    ROOT.with_borrow(|root| {
        root.as_ref()
            .ok_or_else(|| JsValue::from_str("SDK runtime is not open"))?
            .submit(Request {
                id,
                operation,
                handle,
                metadata,
                bytes: bytes.to_vec(),
                control,
            })
    })
}

async fn drive(queue: Arc<Queue>, executor: BrowserExecutor, machine_limit: usize) {
    // All resource/engine handles are owner-local. Pending futures snapshot owned
    // handles before awaiting, and never retain a mutable resources borrow.
    let resources = Rc::new(RefCell::new(super::resources::Resources::new(
        queue.clone(),
        executor.clone(),
        machine_limit,
    )));
    let mut operations = FuturesUnordered::<LocalBoxFuture<'static, ()>>::new();
    queue.event("opened", Value::Null, &[]);
    poll_fn(|cx| {
        let requests = {
            let mut pending = queue.pending.lock().unwrap();
            pending.waker = Some(cx.waker().clone());
            let mut requests = Vec::new();
            // Controls lead each bounded batch, while data gets a fair share.
            for _ in 0..POLL_BUDGET / 2 {
                if let Some(request) = pending.controls.pop_front() {
                    requests.push(request);
                }
            }
            for _ in requests.len()..POLL_BUDGET {
                if let Some(request) = pending
                    .data
                    .pop_front()
                    .or_else(|| pending.controls.pop_front())
                {
                    requests.push(request);
                }
            }
            if !pending.controls.is_empty() || !pending.data.is_empty() {
                cx.waker().wake_by_ref();
            }
            requests
        };
        for request in requests {
            let owner = resources.clone();
            let output = queue.clone();
            operations.push(Box::pin(async move {
                let id = request.id;
                let control = request.control;
                let operation = request.operation.clone();
                let result = super::resources::execute(owner.clone(), request).await;
                match result {
                    Ok((value, bytes)) => output.event(
                        "result",
                        serde_json::json!({"id":id,"ok":true,"value":value}),
                        &bytes,
                    ),
                    Err(error) => output.event(
                        "result",
                        serde_json::json!({"id":id,"ok":false,"error":owner.borrow_mut().store_error(error)}),
                        &[],
                    ),
                }
                output.complete(id, control, &operation);
            }));
        }
        // FuturesUnordered uses B2's parent Parker Waker; it does not create an
        // event-loop Promise or consume the local scheduler's cleanup capacity.
        let mut completed = 0;
        for _ in 0..POLL_BUDGET {
            match std::pin::Pin::new(&mut operations).poll_next(cx) {
                Poll::Ready(Some(())) => {
                    completed += 1;
                }
                Poll::Ready(None) | Poll::Pending => break,
            }
        }
        if completed == POLL_BUDGET {
            cx.waker().wake_by_ref();
        }
        // This admitted owner stays busy for the client lifetime, so B2's
        // ordinary worker-return collection boundary would otherwise be late.
        wasixv2_host::browser::browser_collect();
        if resources.borrow().closed()
            && operations.is_empty()
            && queue.pending.lock().unwrap().ids.is_empty()
        {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    drop(resources);
    executor.close();
    queue.pending.lock().unwrap().closed = true;
    queue.event("closed", Value::Null, &[]);
}
