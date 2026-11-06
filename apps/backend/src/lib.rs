//! Weaklings Manager backend library.

#![recursion_limit = "256"]

pub(crate) mod albion_scope;
pub(crate) mod battle_sync;
pub(crate) mod control_migration;
#[allow(
    dead_code,
    reason = "the Discord outbox is inert until the lifecycle, bot API and scheduler slices consume it"
)]
pub(crate) mod discord_delivery;
pub(crate) mod event_sessions;
pub(crate) mod http_layers;
pub(crate) mod migration;
pub(crate) mod modules;
pub(crate) mod openapi;
pub(crate) mod platform_admins;
pub(crate) mod postgres;
#[allow(
    dead_code,
    reason = "wake/fence/state helpers are consumed by the sync and Discord outbox slices"
)]
pub(crate) mod runtime;
pub(crate) mod tenant;
#[cfg(test)]
#[allow(
    dead_code,
    reason = "fixture surface is extended and consumed by later slices"
)]
pub(crate) mod testkit;
pub(crate) mod ttl_cache;

pub mod config;
pub(crate) mod errors;
pub(crate) mod http_client;
pub(crate) mod pagination;
pub(crate) mod responses;
pub(crate) mod serde_helpers;

use axum::Router;
use axum::extract::MatchedPath;
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

    // The control schema belongs on the control-plane DSN. Using `database_url`
    // here created `control` on the tenant cluster whenever `CONTROL_DATABASE_URL`
    // pointed somewhere else, and the following connection then failed to migrate.
    tracing::info!("connecting to control-plane database");
    let control_admin = sea_orm::Database::connect(cfg.control_plane_url()).await?;

    tracing::info!(
        schema = postgres::CONTROL_SCHEMA,
        "ensuring control-plane schema"
    );
    postgres::ensure_schema(&control_admin, postgres::CONTROL_SCHEMA).await?;
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
    // Template only: it carries no guild, allies or region. Every handler derives
    // the requesting tenant's scope (`BattlesService::for_scope`), so an unscoped
    // use classifies nobody as friendly instead of using the env guild.
    let battles_service = modules::battles::service::BattlesService::new(
        albionbb_service.clone(),
        String::new(),
        &[],
        &[],
        String::new(),
    );

    // Workers reload guild/region from the tenant row. Set the dependencies
    // before the boot loop so `ensure_sync_workers` can see them.
    registry.set_workers(tenant::TenantWorkers {
        albionbb_service: albionbb_service.clone(),
        albiondata_service: albiondata_service.clone(),
    });
    // The one spawn point for periodic loops (fanout and mirror retry today).
    let runtime = runtime::spawn_all(
        control_db.clone(),
        registry.clone(),
        runtime::RuntimeDeps::production(),
    );
    for ctx in &tenant_contexts {
        if !tenant::starts_sync_workers(&ctx.kind) {
            tracing::info!(
                tenant_id = %ctx.tenant_id,
                kind = %ctx.kind,
                "skipping battle/event workers for alliance tenant"
            );
            continue;
        }
        registry
            .ensure_sync_workers(ctx.db.clone(), &ctx.tenant_id, &ctx.kind)
            .await;
    }

    // Template only, like `battles_service`: handlers call `for_scope` with the tenant row.
    let regear_guild_context = modules::regear::router::RegearGuildContext {
        guild_id: String::new(),
        server: String::new(),
    };

    let api = Router::new()
        .route(
            "/openapi.json",
            axum::routing::get(openapi::serve_openapi_json),
        )
        .merge(modules::router())
        .nest("/platform", modules::platform::router())
        .nest("/tenants", modules::platform::public_router())
        .nest("/alliances", modules::platform::alliance_router());

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

    let routes = Router::new()
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
            modules::comps::price_cache::PriceCache::new(),
        ))
        .layer(axum::Extension(
            modules::events::roster_hub::RosterHub::new(),
        ))
        .layer(axum::Extension(runtime))
        .layer(axum::Extension(unscoped_permissions))
        .layer(axum::Extension(platform_admins))
        .layer(axum::Extension(session_key))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &axum::http::Request<_>| {
                    // Keep raw paths and query strings out of telemetry: they can contain
                    // identifiers or OAuth values. MatchedPath is a low-cardinality route template.
                    let route = request
                        .extensions()
                        .get::<MatchedPath>()
                        .map_or("unmatched", MatchedPath::as_str);
                    tracing::info_span!(
                        "http.server.request",
                        "http.request.method" = %request.method(),
                        "http.route" = %route,
                        "http.response.status_code" = tracing::field::Empty,
                    )
                })
                .on_response(
                    |response: &axum::http::Response<axum::body::Body>,
                     latency: std::time::Duration,
                     span: &tracing::Span| {
                        span.record("http.response.status_code", response.status().as_u16());
                        tracing::info!(
                            parent: span,
                            status = %response.status(),
                            latency = ?latency,
                            "finished processing request"
                        );
                    },
                ),
        );

    let app = http_layers::apply(routes).layer(cors);

    tracing::info!(version = config::VERSION, "listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM");
        signal.recv().await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    tracing::info!("shutdown signal received; draining HTTP requests");
}
