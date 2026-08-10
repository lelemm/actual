#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod app_simplefin;
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
