//! Equipment identity — what was actually worn, matched against our own build catalog.
//!
//! Before this module, "build" only meant a planned, hand-authored loadout in
//! `comps::builds`. There was no way to answer "did we actually field that
//! build" or "what is the enemy's current meta" from real battle evidence.
//!
//! A [`Fingerprint`](entities::fingerprint) is an immutable equipment identity —
//! a set of observed slot -> base item type pairs, deduplicated across every
//! battle it has ever been seen in, and matched at most once (at creation
//! time) against the current build catalog. Matching an internal build never
//! retroactively changes an existing fingerprint's match: editing a build
//! later must not silently rewrite history. See
//! `m20260908_000007_create_fingerprint_tables` for the full schema rationale.

pub mod compute;
pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod writer;

pub use router::router;
