//! Utils module.
//!
//! Generic, reusable backend utilities not tied to any specific domain — currently just image
//! OCR via Mistral AI.

pub mod client;
pub mod models;
pub mod router;
pub mod service;

pub use router::router;
