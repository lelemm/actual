#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub mod app_simplefin;
pub mod core;
