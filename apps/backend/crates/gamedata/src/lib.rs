//! Bundled Albion game data (items, spells, rules) and the pure helpers over it.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod data_types;
pub mod dataset;
pub mod pattern;
