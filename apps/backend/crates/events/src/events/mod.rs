//! Events module root.
//!
//! Handles scheduling events and coordinating player sign-ups / comp scaling.

pub mod attribution;
pub mod auto_stop;
#[cfg(test)]
mod battle_link_tests;
pub mod comp_routes;
#[cfg(test)]
mod copy_matrix_tests;
#[cfg(test)]
mod effects_tests;
pub mod fanout_outbox;
pub mod fanout_worker;
pub mod fight_grouping;
pub mod lifecycle;
pub mod loop_tasks;
pub mod mirror_retry;
pub mod models;
pub mod officer_sync;
mod parties;
#[cfg(test)]
mod parties_tests;
pub mod participation_outbox;
#[cfg(test)]
mod platform_leave_tests;
pub mod platform_routes;
pub mod roster_hub;
pub mod router;
pub mod schemas;
pub mod service;
pub mod sync;
#[cfg(test)]
pub mod test_support;

pub use router::router;
