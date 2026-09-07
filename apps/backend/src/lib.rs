//! Weaklings Manager backend library.

#![recursion_limit = "256"]

pub(crate) mod battle_sync;
pub(crate) mod control_migration;
pub(crate) mod event_sessions;
pub(crate) mod migration;
pub(crate) mod modules;
pub(crate) mod openapi;
pub(crate) mod platform_admins;
pub(crate) mod postgres;
pub(crate) mod tenant;

pub mod config;
pub(crate) mod errors;
pub(crate) mod http_client;
pub(crate) mod pagination;
pub(crate) mod responses;
pub(crate) mod serde_helpers;

use axum::Router;
use sea_orm_migration::MigratorTrait;
use std::net::SocketAddr;
use tower_http::{
    cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer},
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_scalar::{Scalar, Servable};

/// Loads config, migrates, and serves HTTP until the process is stopped.
///
/// # Errors
///
/// Returns an error if the database connection fails, migration execution fails, or the server
/// fails to bind to the socket address.
///
/// # Panics
///
/// Panics if the configuration cannot be parsed from the environment.
#[allow(clippy::too_many_lines)]
pub async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config::Config::from_env();

    // Derive the session cookie encryption key once at startup so a misconfigured
    // `SESSION_SECRET` fails the deployment immediately instead of panicking mid-request.
    let session_key = cfg.session_key();

    tracing::info!("connecting to database");
    let admin = sea_orm::Database::connect(&cfg.database_url).await?;

    tracing::info!(
        schema = postgres::CONTROL_SCHEMA,
        "ensuring control-plane schema"
    );
    postgres::ensure_schema(&admin, postgres::CONTROL_SCHEMA).await?;
    tracing::info!("connecting to control-plane");
    let control_db =
        postgres::connect_with_search_path(cfg.control_plane_url(), postgres::CONTROL_SCHEMA)
            .await?;
    tracing::info!("running control-plane migrations");
    control_migration::Migrator::up(&control_db, None).await?;
    tracing::info!("control-plane migrations complete");

    let platform_admins =
        platform_admins::PlatformAdmins::new(Some(cfg.super_admin_discord_id.as_str()));
    platform_admins
        .reload(&control_db)
        .await
        .map_err(|e| format!("Failed to load platform admins: {e}"))?;
    tracing::info!("platform admin cache loaded");

    let registry = tenant::TenantRegistry::new(cfg.database_url.clone(), control_db.clone());
    tracing::info!("warming tenant registry");
    let tenant_contexts = registry.warmup().await?;
    tracing::info!(tenants = tenant_contexts.len(), "tenant registry ready");

    // Placeholder for the handful of endpoints that answer without a tenant
    // (`/api/auth/me`, `/api/auth/logout`): they still destructure an
    // `Extension<Permissions>`, but a request with no tenant has no roles.
    // `resolve_tenant` overwrites this with the real cache for every scoped
    // request, so it never grants anything.
    let unscoped_permissions = modules::auth::Permissions::new_empty();

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
    let battles_server = modules::albionbb::client::normalize_server(Some(&cfg.albion_api_region));
    let battles_service = modules::battles::service::BattlesService::new(
        albionbb_service.clone(),
        cfg.albion_guild_id.clone(),
        battles_server,
    );

    let intel_guild_context = modules::events::service::BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    );
    for ctx in &tenant_contexts {
        tracing::info!(tenant_id = %ctx.tenant_id, "starting per-tenant workers");
        event_sessions::spawn(
            ctx.db.clone(),
            albionbb_service.clone(),
            albiondata_service.clone(),
            cfg.clone(),
            ctx.tenant_id.clone(),
        );
        battle_sync::spawn(
            ctx.db.clone(),
            battles_service.clone(),
            albiondata_service.clone(),
            intel_guild_context.clone(),
            ctx.tenant_id.clone(),
        );
    }
    // From here on, any tenant `registry.provision`s (created after this
    // point, at runtime, through the platform admin API or self-service
    // onboarding) starts its own workers immediately instead of waiting for
    // the next restart — see `TenantRegistry::provision`.
    registry.set_workers(tenant::TenantWorkers {
        cfg: cfg.clone(),
        albionbb_service: albionbb_service.clone(),
        albiondata_service: albiondata_service.clone(),
        battles_service: battles_service.clone(),
    });

    let regear_guild_context = modules::regear::router::RegearGuildContext {
        guild_id: cfg.albion_guild_id.clone(),
        server: modules::albionbb::client::normalize_server(Some(&cfg.albion_api_region)),
    };

    let api = Router::new()
        .merge(modules::router())
        .nest("/platform", modules::platform::router())
        .nest("/tenants", modules::platform::public_router());

    // The browser only ever talks to the frontend's own origin — it proxies
    // `/api` server-to-server, which CORS never governs — so the one origin
    // this API legitimately serves credentialed requests to is the frontend's.
    // `permissive()` let any page on the internet read a signed-in visitor's
    // data by pointing `fetch` straight at this backend; bot traffic is
    // unaffected either way, since CORS only constrains browsers and the bot
    // authenticates server-to-server with `X-Bot-Secret`.
    let frontend_origin = cfg
        .frontend_url
        .trim_end_matches('/')
        .parse()
        .unwrap_or_else(|e| {
            panic!(
                "FRONTEND_URL {:?} is not a valid header value ({e}) — CORS cannot be configured",
                cfg.frontend_url
            )
        });
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::exact(frontend_origin))
        .allow_credentials(true)
        // Wildcards are rejected by the CORS spec once credentials are
        // allowed, so these mirror the actual preflight request instead of
        // sending a literal `*`.
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request());

    let app = Router::new()
        .nest("/api", api)
        .merge(Scalar::with_url("/scalar", openapi::ApiDoc::openapi()))
        .layer(axum::middleware::from_fn_with_state(
            registry.clone(),
            tenant::resolve_tenant,
        ))
        .layer(axum::Extension(tenant::ControlDb(control_db)))
        .layer(axum::Extension(registry.clone()))
        .layer(axum::Extension(cfg.clone()))
        .layer(axum::Extension(openalbion_service))
        .layer(axum::Extension(albiondata_service))
        .layer(axum::Extension(albionbb_service))
        .layer(axum::Extension(battles_service))
        .layer(axum::Extension(regear_guild_context))
        .layer(axum::Extension(modules::intel::cache::ReportCache::new()))
        .layer(axum::Extension(
            modules::events::roster_hub::RosterHub::new(),
        ))
        .layer(axum::Extension(unscoped_permissions))
        .layer(axum::Extension(platform_admins))
        .layer(axum::Extension(session_key))
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    tracing::info!(version = config::VERSION, "listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
