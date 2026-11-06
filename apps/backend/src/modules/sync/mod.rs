//! Copy truth and the read-only guard for synchronized entities.
//!
//! Origin owns, copies are read-only and link back. Every caller that needs to
//! know "is this row a copy?" goes through [`copy_role`] and every write guard
//! goes through [`guard`], so the data source behind the answer can change
//! (slice SY-3a moves it from the legacy `event_sync_links` / `origin_read_only`
//! markers to the tenant `sync_copies` table) without touching any call site.
//!
//! Only the foundation lives here for now: no tables, no routes, no jobs.

pub mod copy_role;
pub mod guard;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

pub use copy_role::{LegacyLinks, SyncKind, copy_role};
pub use guard::{OriginRef, assert_split_writable, assert_writable};
