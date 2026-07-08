//! Health check routing module.
//!
//! Exposes the root health endpoint.

use axum::{routing::get, Json, Router};

use super::models::HealthResponse;
use super::service::HealthService;

/// Creates the router for the health module.
///
/// Serves the root health-check and version endpoint.
pub fn router() -> Router {
    Router::new().route("/", get(health))
}

/// Health check endpoint.
///
/// Returns status "OK" and compile-time version of the service.
async fn health() -> Json<HealthResponse> {
    let service = HealthService::new();
    Json(service.check())
}
