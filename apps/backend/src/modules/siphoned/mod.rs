//! Siphoned module.
//!
//! Provides the routes, services, and schemas for the Guild Siphoned Energy ledger: bulk ingest of
//! the Albion Online export, raw entry listing, per-player balances, and batch management.

pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod status;

pub use router::router;
