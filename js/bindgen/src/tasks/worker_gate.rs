//! Allocator-safe forced termination of pool workers.
//!
//! Every pool worker runs on the SDK's shared linear memory, so they all share
//! one global allocator. Its lock is a bare spin lock with no owner tracking.
//! `Worker.terminate()` stops a worker wherever it happens to be. If that is
//! inside the allocator, the lock is never released and every other thread,
//! the main thread included, spins forever on its next allocation
//! (wasmer-sdk#542).
//!
//! Each worker therefore gets a [`WorkerGate`] in shared memory. The global
//! allocator records while the worker is inside it, and once the scheduler
//! dooms the worker it can never enter the allocator again: it parks instead.
//! The scheduler dooms a worker, waits until it is outside the allocator, and
//! only then calls `terminate()`.
//!
//! The gate is only installed on pool workers. The main thread never parks.
//!
//! The gate also records the worker's TLS block and stack in SDK memory. A
//! worker must not free them itself: wasm-bindgen's `__wbindgen_thread_destroy`
//! invalidates the TLS base and then frees the stack while holding a global
//! temporary-stack lock, so any allocator hook reading TLS there traps with
//! that lock held and blocks every later thread start. The scheduler frees
//! them on the main thread once the worker is known to be gone.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::atomic::{AtomicU32, Ordering::SeqCst},
};

/// Shared-memory termination state for one pool worker.
#[derive(Debug, Default)]
#[repr(C, align(64))]
pub(crate) struct WorkerGate {
    /// Set by the worker while it is inside the global allocator.
    in_allocator: AtomicU32,
    /// Set by the scheduler; the worker parks at its next allocator entry.
    doomed: AtomicU32,
    /// The worker's wasm-bindgen TLS block, or 0.
    tls_base: AtomicU32,
    /// The worker's wasm-bindgen stack allocation, or 0.
    stack_alloc: AtomicU32,
}

impl WorkerGate {
    /// Allocate a gate for a new worker.
    ///
    /// The gate is never freed: a doomed worker may still be parked on it
    /// after the scheduler has dropped its handle, and the browser does not
    /// tell us when a terminated worker has actually stopped running.
    pub(crate) fn leak() -> &'static WorkerGate {
        Box::leak(Box::default())
    }

    /// The address passed to the worker in its `init` message.
    pub(crate) fn address(&'static self) -> u32 {
        self as *const WorkerGate as usize as u32
    }

    /// Forbid the worker from entering the allocator again.
    pub(crate) fn doom(&self) {
        self.doomed.store(1, SeqCst);
    }

    /// Whether the worker may currently hold the allocator lock.
    ///
    /// Only meaningful after [`Self::doom`]: from then on, once this returns
    /// `false` it stays `false`.
    pub(crate) fn in_allocator(&self) -> bool {
        self.in_allocator.load(SeqCst) != 0
    }

    /// Free the worker's TLS block and stack, at most once.
    ///
    /// Call only after the worker has stopped running SDK code: it exited
    /// from its message loop, retired, or (on Node) reported its exit.
    pub(crate) fn release_thread_memory(&self) {
        let tls_base = self.tls_base.swap(0, SeqCst);
        let stack_alloc = self.stack_alloc.swap(0, SeqCst);
        if tls_base == 0 && stack_alloc == 0 {
            return;
        }
        // With explicit addresses, wasm-bindgen frees another thread's TLS
        // and stack using the caller's own stack, without touching the
        // caller's TLS or the temporary-stack lock. A zero stack size selects
        // wasm-bindgen's default, which the SDK does not override.
        let destroy = js_sys::Reflect::get(
            &wasm_bindgen::exports(),
            &wasm_bindgen::JsValue::from_str("__wbindgen_thread_destroy"),
        )
        .ok()
        .and_then(|value| wasm_bindgen::JsCast::dyn_into::<js_sys::Function>(value).ok());
        if let Some(destroy) = destroy {
            let _ = destroy.call3(
                &wasm_bindgen::JsValue::UNDEFINED,
                &tls_base.into(),
                &stack_alloc.into(),
                &0.into(),
            );
        }
    }
}

thread_local! {
    static CURRENT: Cell<*const WorkerGate> = const { Cell::new(std::ptr::null()) };
}

/// Install the gate for the current worker thread and record where its
/// wasm-bindgen TLS block and stack live.
///
/// # Safety
///
/// `address` must be `0` or come from [`WorkerGate::address`].
pub(crate) unsafe fn install(address: u32, tls_base: u32, stack_alloc: u32) {
    let gate = address as usize as *const WorkerGate;
    if let Some(gate) = unsafe { gate.as_ref() } {
        gate.tls_base.store(tls_base, SeqCst);
        gate.stack_alloc.store(stack_alloc, SeqCst);
    }
    CURRENT.with(|current| current.set(gate));
}

struct Entered(Option<&'static WorkerGate>);

impl Drop for Entered {
    #[inline]
    fn drop(&mut self) {
        if let Some(gate) = self.0 {
            gate.in_allocator.store(0, SeqCst);
        }
    }
}

#[inline]
fn enter() -> Entered {
    let gate = CURRENT.with(|current| current.get());
    if gate.is_null() {
        return Entered(None);
    }
    // Safety: installed gates are leaked and never freed.
    let gate: &'static WorkerGate = unsafe { &*gate };
    // Dekker-style handshake with `doom()` + `in_allocator()`: both sides use
    // sequentially consistent accesses, so either the scheduler sees this
    // store, or this thread sees the doom and never touches the allocator.
    gate.in_allocator.store(1, SeqCst);
    if gate.doomed.load(SeqCst) != 0 {
        gate.in_allocator.store(0, SeqCst);
        park_forever();
    }
    Entered(Some(gate))
}

/// Hold a doomed worker outside the allocator until it is terminated.
///
/// This only runs between `doom()` and the worker actually stopping, which the
/// scheduler starts as soon as the worker is outside the allocator. A blocking
/// wait would save the spin, but `memory.atomic.wait32` is not yet a stable
/// intrinsic, and anything that could allocate (thread parking, JS calls) must
/// not run here.
#[cold]
fn park_forever() -> ! {
    loop {
        std::hint::spin_loop();
    }
}

/// The SDK's global allocator: the system allocator behind a [`WorkerGate`].
pub(crate) struct GatedAllocator;

// Safety: every method forwards to `System` unchanged; the gate only delays
// (or forever blocks) entry and never touches the allocation itself.
//
// The methods stay out of line: with fat LTO, inlining them (and the system
// allocator behind them) into every allocation site costs over 100 KB of Wasm.
unsafe impl GlobalAlloc for GatedAllocator {
    #[inline(never)]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _entered = enter();
        unsafe { System.alloc(layout) }
    }

    #[inline(never)]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let _entered = enter();
        unsafe { System.alloc_zeroed(layout) }
    }

    #[inline(never)]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _entered = enter();
        unsafe { System.dealloc(ptr, layout) }
    }

    #[inline(never)]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _entered = enter();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: GatedAllocator = GatedAllocator;

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    fn ungated_threads_allocate_normally() {
        let values: Vec<u64> = (0..1024).collect();
        assert_eq!(values.iter().sum::<u64>(), 1023 * 1024 / 2);
    }

    #[wasm_bindgen_test]
    fn doomed_gate_reports_allocator_exit() {
        let gate = WorkerGate::leak();
        assert!(!gate.in_allocator());
        gate.in_allocator.store(1, SeqCst);
        gate.doom();
        assert!(gate.in_allocator());
        drop(Entered(Some(gate)));
        assert!(!gate.in_allocator());
    }
}
