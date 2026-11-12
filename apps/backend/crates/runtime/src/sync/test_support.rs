//! SQLite fixtures for copy-role and guard tests.
//!
//! One in-memory database plays both roles: it carries the tenant migrations
//! (events, splits, ...) and minimal stand-ins for the Postgres-only control tables
//! the legacy backing reads (`event_sync_links`, `alliance_shares`, `tenants`).

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection, DbBackend, Statement,
};

use backend_entities::splits::split;
use backend_entities::users;

/// Migrated tenant schema plus the control stand-in tables.
pub async fn sqlite_db() -> DatabaseConnection {
    let db = backend_migration::testkit::migrated_sqlite().await;
    db.execute_unprepared(
        "CREATE TABLE event_sync_links (
            source_tenant_id TEXT NOT NULL,
            source_event_id BIGINT NOT NULL,
            mirror_tenant_id TEXT NOT NULL,
            mirror_event_id BIGINT NOT NULL,
            sync_enabled BOOLEAN NOT NULL DEFAULT TRUE
        )",
    )
    .await
    .expect("event_sync_links");
    db.execute_unprepared(
        "CREATE TABLE alliance_shares (
            alliance_tenant_id TEXT NOT NULL,
            source_tenant_id TEXT NOT NULL,
            artifact_type TEXT NOT NULL,
            source_id BIGINT NOT NULL,
            published_id BIGINT NOT NULL
        )",
    )
    .await
    .expect("alliance_shares");
    db.execute_unprepared(
        "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL)",
    )
    .await
    .expect("tenants");
    db
}

/// Registers a tenant label the guard can decorate errors with.
pub async fn register_tenant(db: &DatabaseConnection, id: &str, name: &str, kind: &str) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO tenants (id, name, kind) VALUES ($1, $2, $3)",
        [id.into(), name.into(), kind.into()],
    ))
    .await
    .expect("insert tenant");
}

/// Links `mirror_tenant:mirror_event` as a copy of `source_tenant:source_event`.
pub async fn link_event(
    db: &DatabaseConnection,
    source: (&str, i64),
    mirror: (&str, i64),
    enabled: bool,
) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO event_sync_links \
         (source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id, sync_enabled) \
         VALUES ($1, $2, $3, $4, $5)",
        [
            source.0.into(),
            source.1.into(),
            mirror.0.into(),
            mirror.1.into(),
            enabled.into(),
        ],
    ))
    .await
    .expect("insert event link");
}

/// Records that `source_tenant:source_id` was published as `published_id` in the alliance.
pub async fn share_split(
    db: &DatabaseConnection,
    alliance_tenant: &str,
    source: (&str, i64),
    published_id: i64,
) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO alliance_shares \
         (alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id) \
         VALUES ($1, $2, 'split', $3, $4)",
        [
            alliance_tenant.into(),
            source.0.into(),
            source.1.into(),
            published_id.into(),
        ],
    ))
    .await
    .expect("insert split share");
}

/// Inserts a user and returns its id.
pub async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
    users::ActiveModel {
        username: Set(name.to_owned()),
        email: Set(format!("{name}@example.com")),
        role: Set("User".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert user")
    .id
}

/// Inserts a pending split; `origin_read_only` marks it as a published copy.
pub async fn insert_split(db: &DatabaseConnection, created_by: i64, origin_read_only: bool) -> i64 {
    split::ActiveModel {
        created_by: Set(created_by),
        status: Set("pending".to_owned()),
        estimated_market_value: Set("100".parse().expect("decimal")),
        fee: Set("10".parse().expect("decimal")),
        repair_value: Set("0".parse().expect("decimal")),
        bags_value: Set("0".parse().expect("decimal")),
        origin_read_only: Set(origin_read_only),
        created_at: Set(Utc::now().into()),
        updated_at: Set(Utc::now().into()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("insert split")
    .id
}

// --- Route matrix harness -------------------------------------------------

/// Bot secret the matrix harness authenticates with. A bot request without an
/// `X-Discord-Id` is the trusted "system" caller, which holds every permission, so the
/// matrix measures the copy guard and not RBAC.
const MATRIX_BOT_SECRET: &str = "matrix-secret";

fn matrix_config() -> backend_core::config::Config {
    backend_core::config::Config {
        backend_port: 3000,
        database_url: "sqlite::memory:".to_owned(),
        control_database_url: None,
        discord_client_id: "id".to_owned(),
        discord_client_secret: "secret".to_owned(),
        discord_redirect_uri: "http://localhost/callback".to_owned(),
        bot_api_secret: Some(MATRIX_BOT_SECRET.to_owned()),
        discord_bot_token: None,
        super_admin_discord_id: "admin".to_owned(),
        session_secret: "x".repeat(64),
        frontend_url: "http://localhost".to_owned(),
        albion_api_region: "europe".to_owned(),
        albion_guild_id: "albion".to_owned(),
        albion_allied_guild_ids: String::new(),
        albion_allied_guild_names: String::new(),
        mistral_api_key: String::new(),
        albionbb_base_url: "http://localhost".to_owned(),
        albionbb_request_timeout_secs: 60,
        albiondata_request_timeout_secs: 30,
        discord_api_base: "http://127.0.0.1:1/api/v10".to_owned(),
        discord_api_timeout_secs: 10,
        module_kind_enforcement: "log".to_owned(),
    }
}

/// Layers a module router with the shared extensions the real server provides, all backed
/// by `db`. Feature-specific extensions (the events router's `RosterHub` and
/// `AlbionBbService`) are added by that feature's own harness.
pub fn matrix_app(
    routes: axum::Router,
    db: &DatabaseConnection,
    tenant_id: &str,
    tenant_kind: &str,
) -> axum::Router {
    let registry =
        backend_identity::tenant::TenantRegistry::new("sqlite::memory:".to_owned(), db.clone());
    matrix_app_with_registry(routes, db, tenant_id, tenant_kind, registry)
}

/// [`matrix_app`] with a caller-supplied registry, so a test can cache the contexts of other
/// tenants (see [`matrix_tenant`]) the request may be routed to.
pub fn matrix_app_with_registry(
    routes: axum::Router,
    db: &DatabaseConnection,
    tenant_id: &str,
    tenant_kind: &str,
    registry: backend_identity::tenant::TenantRegistry,
) -> axum::Router {
    use axum::Extension;
    use backend_identity::auth::Permissions;
    use backend_identity::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind};

    routes
        .layer(Extension(matrix_config()))
        .layer(Extension(Permissions::new_empty()))
        .layer(Extension(db.clone()))
        .layer(Extension(ControlDb(db.clone())))
        .layer(Extension(CurrentTenantId(tenant_id.to_owned())))
        .layer(Extension(CurrentTenantKind(tenant_kind.to_owned())))
        .layer(Extension(registry))
}

/// A tenant context backed by `db`, for [`backend_identity::tenant::TenantRegistry::cache_context_for_tests`].
#[must_use]
pub fn matrix_tenant(
    tenant_id: &str,
    kind: &str,
    db: &DatabaseConnection,
) -> std::sync::Arc<backend_identity::tenant::TenantContext> {
    std::sync::Arc::new(backend_identity::tenant::TenantContext {
        tenant_id: tenant_id.to_owned(),
        schema_name: format!("matrix_{tenant_id}"),
        db: db.clone(),
        permissions: backend_identity::auth::Permissions::new_empty(),
        features: std::collections::HashSet::new(),
        kind: kind.to_owned(),
    })
}

/// Sends one request through `app` as the bot system caller and returns status + JSON body.
pub async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> (axum::http::StatusCode, serde_json::Value) {
    call_with_headers(app, method, path, body, &[]).await
}

/// [`call`] with extra request headers, e.g. `X-Discord-Id` to act as a member through the bot.
pub async fn call_with_headers(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    headers: &[(&str, &str)],
) -> (axum::http::StatusCode, serde_json::Value) {
    use tower::ServiceExt;

    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(
            backend_identity::tenant::BOT_SECRET_HEADER,
            MATRIX_BOT_SECRET,
        );
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let body = match body {
        Some(json) => {
            builder = builder.header("content-type", "application/json");
            axum::body::Body::from(json.to_string())
        }
        None => axum::body::Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}
