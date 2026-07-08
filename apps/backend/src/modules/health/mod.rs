//! Health check module.
//!
//! Provides the `GET /` endpoint that returns the service status and compile-time version.

pub mod models;
pub mod router;
pub mod service;

pub use router::router;
