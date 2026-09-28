//! Backend entry point.
//!
//! Configures and runs the Axum web server exposing modular REST APIs and `OpenAPI` docs.

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod telemetry;

/// Starts the HTTP server.
///
/// # Errors
///
/// Returns an error if the database connection fails, migration execution fails, or the server
/// fails to bind to the socket address.
///
/// # Panics
///
/// Panics if the configuration cannot be parsed from the environment.
#[tokio::main]
pub async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let tracer_provider = telemetry::init_tracer_provider();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=debug,tower_http=debug,sqlx=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(telemetry::tracing_layer())
        .init();

    let server_result = backend::run_server().await;

    if let Some(provider) = tracer_provider
        && provider.shutdown().is_err()
    {
        tracing::warn!("failed to flush OpenTelemetry spans during shutdown");
    }

    server_result
}
