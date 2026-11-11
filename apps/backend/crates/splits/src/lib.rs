//! Splits module.
//!
//! Provides the routes, services, and schemas for creating and finalizing loot splits.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod alliance_distribution;
pub mod city;
#[cfg(test)]
mod copy_matrix_tests;
pub mod discord_sync;
pub mod models;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::router;
