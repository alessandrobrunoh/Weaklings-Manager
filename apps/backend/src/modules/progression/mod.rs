//! Progression module.
//!
//! Season-scoped XP and levels. Other modules grant XP through
//! [`service::ProgressionService::award`]; they never compute the curve themselves.

pub mod curve;
pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod status;

pub use router::router;
