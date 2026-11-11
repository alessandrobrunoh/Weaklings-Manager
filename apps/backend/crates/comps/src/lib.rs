//! Comps module.
//!
//! Provides the routes, services, and schemas for managing build categories, comp categories,
//! builds, build items, comps, and `comp_builds` (compositions of builds for Albion Online).

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod authority;
pub mod models;
pub mod price_cache;
pub mod pricing;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::router;
