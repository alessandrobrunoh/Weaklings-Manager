//! Backend entry point.
//!
//! Configures and runs the Axum web server exposing modular REST APIs and `OpenAPI` docs.

mod config;
pub mod errors;
mod event_sessions;
mod migration;
mod modules;
mod openapi;
pub mod pagination;
pub mod responses;

use axum::Router;
use migration::MigratorTrait;
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use utoipa::OpenApi;
use utoipa_scalar::{Scalar, Servable};

/// Starts the HTTP server.
///
/// Loads environment variables, configures tracing subscribers, sets up Axum router with
/// nested endpoints, connects to the Postgres database, runs pending migrations, and binds to
/// the specified server port.
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

    let cfg = config::Config::from_env();

    // Establish connection to Postgres database
    tracing::info!("connecting to database");
    let db = sea_orm::Database::connect(&cfg.database_url).await?;

    // Run migrations
    tracing::info!("running database migrations");
    migration::Migrator::up(&db, None).await?;
    tracing::info!("database migrations complete");

    // Load the role→permission cache from the database. Reloadable at runtime
    // via POST /api/admin/permissions/reload — no redeploy needed to change
    // who can do what.
    let permissions = modules::auth::Permissions::new_empty();
    permissions
        .reload(&db)
        .await
        .map_err(|e| format!("Failed to load permission cache: {e}"))?;
    tracing::info!("permission cache loaded");

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.backend_port));

    let openalbion_service = modules::openalbion::service::OpenAlbionService::new();
    let albiondata_service = modules::albiondata::service::AlbionDataService::new(
        cfg.albion_api_region.clone(),
        Some(cfg.albiondata_request_timeout_secs),
    );
    let albionbb_client = modules::albionbb::client::AlbionBbApiClient::new(
        Some(cfg.albionbb_base_url.clone()),
        Some(cfg.albionbb_request_timeout_secs),
    );
    let albionbb_service = modules::albionbb::service::AlbionBbService::new(albionbb_client);
    // Derive the AlbionBB server segment (eu/na/asia) from the configured region.
    let battles_server = modules::albionbb::client::normalize_server(Some(&cfg.albion_api_region));
    let battles_service = modules::battles::service::BattlesService::new(
        albionbb_service.clone(),
        cfg.albion_guild_id.clone(),
        battles_server,
    );

    event_sessions::spawn(db.clone(), albionbb_service.clone(), cfg.clone());

    let app = Router::new()
        .nest("/api", modules::router())
        .merge(Scalar::with_url("/scalar", openapi::ApiDoc::openapi()))
        .layer(axum::Extension(db.clone()))
        .layer(axum::Extension(cfg.clone()))
        .layer(axum::Extension(openalbion_service))
        .layer(axum::Extension(albiondata_service))
        .layer(axum::Extension(albionbb_service))
        .layer(axum::Extension(battles_service))
        .layer(axum::Extension(permissions.clone()))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

    tracing::info!(version = config::VERSION, "listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
