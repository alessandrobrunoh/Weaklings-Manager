//! Shared foundation of the backend: errors, config, Postgres helpers, HTTP layers, response
//! envelopes and the small cross-feature value types.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod albion_common;
pub mod config;
pub mod errors;
pub mod http_client;
pub mod http_layers;
pub mod pagination;
pub mod platform_admins;
pub mod postgres;
pub mod ratios;
pub mod responses;
pub mod serde_helpers;
pub mod sync_origin;
#[cfg(any(test, feature = "test-support"))]
pub mod testkit;
pub mod ttl_cache;
