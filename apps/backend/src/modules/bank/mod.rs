//! Bank module.
//!
//! Provides the routes, services, and schemas for the Guild Bank ledger: balances,
//! transaction listing, and withdrawals.

pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod status;

pub use router::router;
