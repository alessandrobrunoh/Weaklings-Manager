//! Events module root.
//!
//! Handles scheduling events and coordinating player sign-ups / comp scaling.

pub mod entities;
pub mod fight_grouping;
pub mod models;
pub mod roster_hub;
pub mod router;
pub mod service;
pub mod sync;

pub use router::router;
