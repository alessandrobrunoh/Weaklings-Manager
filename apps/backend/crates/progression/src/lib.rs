//! Progression module.
//!
//! Season-scoped XP and levels. Other modules grant XP through
//! [`service::ProgressionService::award`]; they never compute the curve themselves.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod curve;
pub mod models;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::router;
