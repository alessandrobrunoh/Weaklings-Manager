//! Enemy scouting and guild analytics.
//!
//! Intel turns raw battle snapshots into two things officers can act on:
//! a library of **scouted enemy compositions** with similarity scoring and
//! win/loss matchups against our own comps, and a **guild report** aggregate
//! covering performance, attendance, roster and silver flow.
//!
//! Layering, from pure to stateful:
//! - [`similarity`] — the scoring maths, DB-free and fixture-tested.
//! - [`roles`] — weapon → role classification, curated tier plus heuristics.

pub mod auto_scout;
pub mod cache;
pub mod entities;
pub mod matchups;
pub mod models;
pub mod report;
pub mod roles;
pub mod router;
pub mod scout;
pub mod service;
pub mod similarity;
pub mod status;

pub use router::router;
