//! Health check response DTOs.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over
//! the API.

use serde::Serialize;

/// Health status response structure.
#[derive(Serialize)]
pub struct HealthResponse {
    /// The status of the server ("OK").
    pub status: &'static str,
    /// The compile-time version of the application package.
    pub version: &'static str,
}
