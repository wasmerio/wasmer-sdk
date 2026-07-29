use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

/// JavaScript futures are bound to one worker. WASIX's platform-neutral task
/// interfaces require `Send + Sync`, while the worker scheduler guarantees
/// that this future is only polled on the worker where it was created.
pub(crate) struct JsSendFuture(pub(crate) wasm_bindgen_futures::JsFuture);

unsafe impl Send for JsSendFuture {}
unsafe impl Sync for JsSendFuture {}

impl Future for JsSendFuture {
    type Output = Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        // SAFETY: `JsFuture` is never moved after this wrapper is pinned.
        unsafe { Pin::new_unchecked(&mut self.0) }.poll(context)
    }
}
