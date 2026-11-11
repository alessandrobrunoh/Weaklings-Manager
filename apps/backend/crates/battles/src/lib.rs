//! Battles, enemies, fingerprints, fight analytics, battle economy and weapon-role classification.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod battles;
pub mod economy;
pub mod enemies;
pub mod fight_analytics;
pub mod fingerprints;
