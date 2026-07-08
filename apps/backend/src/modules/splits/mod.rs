//! Splits module.
//!
//! Provides the routes, services, and schemas for creating and finalizing loot splits.

pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod status;

pub use router::router;
