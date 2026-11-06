//! Events module root.
//!
//! Handles scheduling events and coordinating player sign-ups / comp scaling.

pub mod attribution;
#[cfg(test)]
mod copy_matrix_tests;
#[cfg(test)]
mod effects_tests;
pub mod entities;
pub mod fanout_outbox;
pub mod fanout_worker;
pub mod fight_grouping;
pub mod lifecycle;
pub mod mirror_retry;
pub mod models;
pub mod roster_hub;
pub mod router;
pub mod service;
pub mod status;
pub mod sync;

pub use router::router;
