//! Comps module.
//!
//! Provides the routes, services, and schemas for managing build categories, comp categories,
//! builds, build items, comps, and comp_builds (compositions of builds for Albion Online).

pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod status;

pub use router::router;
