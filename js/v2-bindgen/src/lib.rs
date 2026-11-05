//! SDK worker bindings. Runtime Rust is instantiated only on B2-owned workers.
#[cfg(target_arch = "wasm32")]
mod driver;
#[cfg(target_arch = "wasm32")]
mod resources;

#[cfg(target_arch = "wasm32")]
pub use driver::*;
