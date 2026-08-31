//! Local Albion equipment catalog module.
//!
//! The public API surface keeps the historical `/api/openalbion/*` routes for compatibility, but
//! every response is now served from the curated local catalog. No third-party item API is used.

pub mod catalog;
pub mod router;
pub mod service;

pub use router::router;
