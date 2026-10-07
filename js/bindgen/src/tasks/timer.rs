use crate::tasks::interop::Serializer;
use futures::{FutureExt, pin_mut, select};
use js_sys::{Array, BigInt, Function, Promise};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

#[wasm_bindgen(inline_js = r#"
const wasmerTimerSetTimeout = globalThis.setTimeout.bind(globalThis);
const wasmerTimerClearTimeout = globalThis.clearTimeout.bind(globalThis);
const WasmerTimerPromise = globalThis.Promise;
export function wasmer_sdk_start_timer(milliseconds) {
  let finish;
  const promise = new WasmerTimerPromise(resolve => { finish = resolve; });
  const handle = wasmerTimerSetTimeout(finish, milliseconds);
  return [promise, () => {
    wasmerTimerClearTimeout(handle);
    // Settle the Promise too: an abandoned JsFuture otherwise keeps its
    // resolve/reject callbacks and Rust waker alive until the timer expires.
    finish();
  }];
}
"#)]
extern "C" {
    fn wasmer_sdk_start_timer(milliseconds: i32) -> Array;
}

struct HostTimer {
    promise: Promise,
    cancel: Function,
}

impl HostTimer {
    fn new(milliseconds: i32) -> Self {
        let timer = wasmer_sdk_start_timer(milliseconds);
        Self {
            promise: timer.get(0).unchecked_into(),
            cancel: timer.get(1).unchecked_into(),
        }
    }
}

impl Drop for HostTimer {
    fn drop(&mut self) {
        let _ = self.cancel.call0(&JsValue::UNDEFINED);
    }
}

/// A timer carries only shared Rust state, never worker-local JS handles.
/// In particular, polling must not clone every live guest memory into an
/// otherwise quiet worker, where WebKit can retain its reservation until GC.
#[derive(Debug)]
pub(crate) struct Timer {
    pub millis: i32,
    pub completion: tokio::sync::oneshot::Sender<()>,
}

impl Timer {
    pub fn into_js(self) -> Result<JsValue, crate::worker_utils::Error> {
        let address = Box::into_raw(Box::new(self)) as usize;
        Serializer::new("timer")
            .set("ptr", BigInt::from(address))
            .finish()
    }

    pub async fn run(mut self) {
        if self.completion.is_closed() {
            return;
        }
        let timer = HostTimer::new(self.millis);
        let elapsed = {
            let timeout = wasm_bindgen_futures::JsFuture::from(timer.promise.clone()).fuse();
            let cancelled = self.completion.closed().fuse();
            pin_mut!(timeout, cancelled);
            select! {
                _ = timeout => true,
                _ = cancelled => false,
            }
        };
        if elapsed {
            let _ = self.completion.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::PostMessagePayload;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    async fn timer_does_not_transfer_live_guest_memory() {
        let mut store = wasmer::Store::default();
        let memory =
            wasmer::Memory::new(&mut store, wasmer::MemoryType::new(1, Some(32), true)).unwrap();
        let (completion, done) = tokio::sync::oneshot::channel();
        let message = Timer {
            millis: 1,
            completion,
        }
        .into_js()
        .unwrap();
        assert!(!js_sys::Array::is_array(&message));
        match unsafe { PostMessagePayload::try_from_js(message) }.unwrap() {
            PostMessagePayload::Timer(timer) => timer.run().await,
            _ => panic!("expected timer"),
        }
        done.await.unwrap();
        drop(memory);
    }

    #[wasm_bindgen_test]
    async fn dropping_a_timer_waiter_cancels_the_running_host_timeout() {
        use std::{
            future::Future,
            task::{Context, Poll},
        };

        let (completion, done) = tokio::sync::oneshot::channel();
        let mut timer = Box::pin(
            Timer {
                millis: 60_000,
                completion,
            }
            .run(),
        );
        let waker = futures::task::noop_waker();
        assert!(
            timer
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        drop(done);
        assert!(matches!(
            timer.as_mut().poll(&mut Context::from_waker(&waker)),
            Poll::Ready(())
        ));
        // Let the settled Promise drain its JsFuture callbacks.
        wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&JsValue::UNDEFINED))
            .await
            .unwrap();
    }
}
