//! Users module.
//!
//! Provides the routes, services, and schemas for managing and inspecting user data.

pub mod block;
pub mod display_name;
pub mod identity;
pub mod member_roles;
pub mod router;
pub mod schemas;
pub mod service;
pub mod weapons;

pub use router::router;
