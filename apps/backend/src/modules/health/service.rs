//! Health check service logic module.
//!
//! Provides the business logic for the health check endpoint.

use crate::config;

use super::models::HealthResponse;

/// Service for executing health check logic.
pub struct HealthService;

impl HealthService {
    /// Creates a new instance of the `HealthService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Returns the current health status of the service.
    #[must_use]
    pub fn check(&self) -> HealthResponse {
        HealthResponse {
            status: "OK",
            version: config::VERSION,
        }
    }
}

impl Default for HealthService {
    fn default() -> Self {
        Self::new()
    }
}
