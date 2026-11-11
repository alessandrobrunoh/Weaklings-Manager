//! Shared test fixtures (`test-support`).

#[cfg(any(test, feature = "test-support"))]
pub mod discord_stub;
#[cfg(any(test, feature = "test-support"))]
pub mod queries;
