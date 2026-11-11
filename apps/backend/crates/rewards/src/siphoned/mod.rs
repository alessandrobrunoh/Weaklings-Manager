//! Siphoned module.
//!
//! Provides the routes, services, and schemas for the Guild Siphoned Energy ledger: bulk ingest of
//! the Albion Online export, raw entry listing, per-player balances, and batch management.

pub mod models;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::router;
