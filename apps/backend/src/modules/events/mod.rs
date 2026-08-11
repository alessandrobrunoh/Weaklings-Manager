//! Events module root.
//!
//! Handles scheduling events and coordinating player sign-ups / comp scaling.

pub mod entities;
pub mod models;
pub mod router;
pub mod service;

pub use router::router;
