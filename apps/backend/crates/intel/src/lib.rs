//! Enemy scouting and guild analytics.
//!
//! Intel turns raw battle snapshots into two things officers can act on:
//! a library of **scouted enemy compositions** with similarity scoring and
//! win/loss matchups against our own comps, and a **guild report** aggregate
//! covering performance, attendance, roster and silver flow.
//!
//! Layering, from pure to stateful:
//! - [`similarity`] — the scoring maths, DB-free and fixture-tested.
//! - [`backend_battles::battles::roles`] — weapon → role classification, curated tier plus
//!   heuristics.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod auto_scout;
pub mod cache;
pub mod matchups;
pub mod models;
pub mod report;
pub mod router;
pub mod schemas;
pub mod scout;
pub mod service;
pub mod similarity;

pub use router::router;
