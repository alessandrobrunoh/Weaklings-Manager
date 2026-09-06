//! Backend entry point.
//!
//! Configures and runs the Axum web server exposing modular REST APIs and `OpenAPI` docs.

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

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

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=debug,tower_http=debug,sqlx=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    backend::run_server().await
}
