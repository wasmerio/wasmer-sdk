use crate::{tasks::interop::Serializer, worker_utils::GlobalScope};
use js_sys::BigInt;
use wasm_bindgen::JsValue;

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

    pub async fn run(self) {
        let _ =
            wasm_bindgen_futures::JsFuture::from(GlobalScope::current().sleep(self.millis)).await;
        let _ = self.completion.send(());
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
}
