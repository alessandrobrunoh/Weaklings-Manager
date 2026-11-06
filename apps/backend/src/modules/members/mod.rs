//! Member provisioning from the Discord bot (MS-S2).
//!
//! Gateway sync, reconcile and link propagation are added by later slices; this module owns the
//! bot-verified entry point that creates or reactivates a member row.

pub mod router;

pub use router::router;
