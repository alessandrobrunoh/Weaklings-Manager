//! Sync engine: the tenant outbox, the control-plane job queue, the relay and
//! executor loops, and the copy truth.
//!
//! Origin owns, copies are read-only and link back. This module holds the
//! generic machinery (outbox, relay, queue, engine, status API); each kind
//! registers a [`handler::SyncHandler`] in its own slice. Until a kind is
//! enabled with `SYNC_ENGINE_KINDS`, nothing here changes behaviour.
//!
//! The copy-role accessor and the write guard ([`copy_role`], [`guard`]) predate
//! the engine and keep their signatures.

pub mod copy_role;
pub mod engine;
pub mod error;
pub mod failpoint;
pub mod guard;
pub mod handler;
pub mod inbox;
pub mod jobs;
pub mod model;
pub mod outbox;
pub mod policy;
#[cfg(test)]
mod queue_tests;
pub mod relay;
pub mod router;
#[cfg(test)]
mod router_tests;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

pub use copy_role::{LegacyLinks, SyncKind, copy_role};
pub use guard::{OriginRef, assert_split_writable, assert_writable};
