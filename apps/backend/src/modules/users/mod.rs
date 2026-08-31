//! Users module.
//!
//! Provides the routes, services, and schemas for managing and inspecting user data.

pub mod display_name;
pub mod entities;
pub mod router;
pub mod service;
pub mod specializations;

pub use router::router;
