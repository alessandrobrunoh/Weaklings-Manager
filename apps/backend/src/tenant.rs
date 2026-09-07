//! Per-request tenant resolution.
//!
//! A [`TenantRegistry`] caches one [`TenantContext`] per active tenant (database
//! pool pinned to that tenant's schema, permission cache, feature flags). The
//! Axum middleware reads `X-Guild-Id` or the session cookie's `tenant_id` and
//! inserts the matching `DatabaseConnection` / [`crate::modules::auth::Permissions`]
//! into request extensions so existing handlers keep their signatures.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use dashmap::DashMap;
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use sea_orm_migration::MigratorTrait;

use crate::errors::AppError;
use crate::migration::Migrator;
use crate::modules::auth::Permissions;
use crate::modules::auth::service::DiscordUserProfile;
use crate::postgres::{self, connect_with_search_path, list_active_tenants};

/// Header the Discord bot sends to select a guild/tenant.
pub const GUILD_ID_HEADER: &str = "X-Guild-Id";

/// Control-plane pool, distinct from the per-tenant `DatabaseConnection`.
#[derive(Clone)]
pub struct ControlDb(pub DatabaseConnection);

/// Discord guild id of the tenant resolved for this request.
#[derive(Clone)]
pub struct CurrentTenantId(pub String);

/// Feature flags enabled for the current tenant.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)] // read by Stage 6 handlers via [`TenantFeatures::contains`]
pub struct TenantFeatures(pub HashSet<String>);

impl TenantFeatures {
    /// Whether `key` is enabled for this tenant.
    #[must_use]
    #[allow(dead_code)] // used by Stage 6 feature gates and tests
    pub fn contains(&self, key: &str) -> bool {
        self.0.contains(key)
    }
}

/// Live objects for one tenant.
pub struct TenantContext {
    /// Discord guild id / `tenants.id`.
    pub tenant_id: String,
    /// Postgres schema name.
    pub schema_name: String,
    /// Pool with `search_path` pinned to [`Self::schema_name`].
    pub db: DatabaseConnection,
    /// Role→permission cache loaded from this tenant's `role_permissions`.
    pub permissions: Permissions,
    /// Enabled feature keys from the control-plane.
    pub features: HashSet<String>,
}

/// Lazy cache of [`TenantContext`] keyed by Discord guild id.
#[derive(Clone)]
pub struct TenantRegistry {
    database_url: String,
    control_db: DatabaseConnection,
    inner: Arc<DashMap<String, Arc<TenantContext>>>,
    /// Pre-backfill: serve schema `public` under this guild id when no `tenants` rows exist.
    legacy_guild_id: Option<String>,
    legacy_db: Option<DatabaseConnection>,
}

impl TenantRegistry {
    /// Build an empty registry. Call [`Self::warmup`] before serving traffic.
    #[must_use]
    pub fn new(
        database_url: String,
        control_db: DatabaseConnection,
        legacy_guild_id: Option<String>,
        legacy_db: Option<DatabaseConnection>,
    ) -> Self {
        Self {
            database_url,
            control_db,
            inner: Arc::new(DashMap::new()),
            legacy_guild_id,
            legacy_db,
        }
    }

    /// Load every active tenant (or the legacy `public` schema) so workers can start.
    ///
    /// # Errors
    ///
    /// Returns a database error if a tenant schema cannot be opened or migrated.
    pub async fn warmup(&self) -> Result<Vec<Arc<TenantContext>>, AppError> {
        let active = list_active_tenants(&self.control_db)
            .await
            .map_err(AppError::Database)?;
        if active.is_empty() {
            if let (Some(id), Some(db)) = (&self.legacy_guild_id, &self.legacy_db) {
                let ctx = self.load_legacy(id, db.clone()).await?;
                return Ok(vec![ctx]);
            }
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(active.len());
        for tenant in active {
            out.push(self.get_or_load(&tenant.id).await?);
        }
        Ok(out)
    }

    /// Cached contexts currently loaded.
    #[must_use]
    #[allow(dead_code)] // used by isolation tests
    pub fn cached_len(&self) -> usize {
        self.inner.len()
    }

    /// The only loaded tenant id, if there is exactly one.
    #[must_use]
    #[allow(dead_code)] // kept for diagnostics; HTTP no longer auto-picks a sole tenant
    pub fn sole_tenant_id(&self) -> Option<String> {
        if self.inner.len() == 1 {
            self.inner.iter().next().map(|entry| entry.key().clone())
        } else {
            None
        }
    }

    /// Return a cached context, loading it on first use.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the tenant is missing or not `active`,
    /// or a database error if the schema cannot be opened.
    pub async fn get_or_load(&self, tenant_id: &str) -> Result<Arc<TenantContext>, AppError> {
        if let Some(ctx) = self.inner.get(tenant_id) {
            return Ok(ctx.clone());
        }
        let ctx = self.load(tenant_id).await?;
        self.inner.insert(tenant_id.to_owned(), ctx.clone());
        Ok(ctx)
    }

    /// Drop a cached context so the next request reloads flags, status, and pool.
    pub fn evict(&self, tenant_id: &str) {
        self.inner.remove(tenant_id);
    }

    /// Create the Postgres schema, run tenant migrations, and cache the context.
    ///
    /// Used when provisioning a brand-new tenant (row may still be `provisioning`).
    ///
    /// # Errors
    ///
    /// Returns a database error if the schema cannot be created or migrated.
    pub async fn provision(
        &self,
        tenant_id: &str,
        schema_name: &str,
    ) -> Result<Arc<TenantContext>, AppError> {
        postgres::ensure_schema(&self.control_db, schema_name)
            .await
            .map_err(AppError::Database)?;
        let ctx = self.open_context(tenant_id, schema_name).await?;
        self.inner.insert(tenant_id.to_owned(), ctx.clone());
        Ok(ctx)
    }

    async fn load(&self, tenant_id: &str) -> Result<Arc<TenantContext>, AppError> {
        let row = self
            .control_db
            .query_one(Statement::from_sql_and_values(
                self.control_db.get_database_backend(),
                "SELECT schema_name, status FROM tenants WHERE id = $1",
                [tenant_id.into()],
            ))
            .await
            .map_err(AppError::Database)?;

        let Some(row) = row else {
            if self.legacy_guild_id.as_deref() == Some(tenant_id)
                && let Some(db) = &self.legacy_db
            {
                return self.load_legacy(tenant_id, db.clone()).await;
            }
            return Err(AppError::NotFound(format!(
                "tenant {tenant_id} is not registered"
            )));
        };

        let schema_name: String = row.try_get_by_index(0).map_err(AppError::Database)?;
        let status: String = row.try_get_by_index(1).map_err(AppError::Database)?;
        if status != "active" {
            return Err(AppError::Forbidden(format!(
                "tenant {tenant_id} is {status}"
            )));
        }
        postgres::validate_schema_name(&schema_name).map_err(AppError::Database)?;
        self.open_context(tenant_id, &schema_name).await
    }

    async fn load_legacy(
        &self,
        tenant_id: &str,
        db: DatabaseConnection,
    ) -> Result<Arc<TenantContext>, AppError> {
        Migrator::up(&db, None).await.map_err(AppError::Database)?;
        let permissions = Permissions::new_empty();
        permissions.reload(&db).await.map_err(AppError::Database)?;
        let ctx = Arc::new(TenantContext {
            tenant_id: tenant_id.to_owned(),
            schema_name: "public".to_owned(),
            db,
            permissions,
            features: HashSet::new(),
        });
        self.inner.insert(tenant_id.to_owned(), ctx.clone());
        Ok(ctx)
    }

    async fn open_context(
        &self,
        tenant_id: &str,
        schema_name: &str,
    ) -> Result<Arc<TenantContext>, AppError> {
        let db = connect_with_search_path(&self.database_url, schema_name)
            .await
            .map_err(AppError::Database)?;
        Migrator::up(&db, None).await.map_err(AppError::Database)?;
        let permissions = Permissions::new_empty();
        permissions.reload(&db).await.map_err(AppError::Database)?;
        let features = load_features(&self.control_db, tenant_id).await?;
        Ok(Arc::new(TenantContext {
            tenant_id: tenant_id.to_owned(),
            schema_name: schema_name.to_owned(),
            db,
            permissions,
            features,
        }))
    }
}

async fn load_features(
    control_db: &DatabaseConnection,
    tenant_id: &str,
) -> Result<HashSet<String>, AppError> {
    let rows = control_db
        .query_all(Statement::from_sql_and_values(
            control_db.get_database_backend(),
            "SELECT feature_key FROM tenant_feature_flags \
             WHERE tenant_id = $1 AND enabled = true",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let mut features = HashSet::new();
    for row in rows {
        features.insert(
            row.try_get_by_index::<String>(0)
                .map_err(AppError::Database)?,
        );
    }
    Ok(features)
}

/// Paths that must not wait on a tenant (health, OAuth bootstrap, platform).
#[must_use]
pub fn skip_tenant_resolution(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path == "/api/health"
        || path == "/api/auth/discord/login"
        || path == "/api/auth/discord/callback"
        || path == "/api/auth/pending-tenants"
        || path == "/api/auth/select-tenant"
        || path.starts_with("/api/platform")
        || path.starts_with("/api/tenants")
        || path == "/api/auth/tenants"
        || path == "/api/auth/switch-tenant"
        || path == "/api/auth/registerable-guilds"
}

fn is_unscoped_auth_path(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path == "/api/auth/me"
        || path == "/api/auth/logout"
        || path == "/api/auth/tenants"
        || path == "/api/auth/registerable-guilds"
}

/// Resolve a tenant id from the bot header, the session cookie, or a sole tenant.
#[must_use]
pub fn resolve_tenant_id(
    headers: &HeaderMap,
    cookie_tenant_id: Option<&str>,
    sole_tenant_id: Option<&str>,
) -> Option<String> {
    if let Some(id) = headers
        .get(GUILD_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(id.to_owned());
    }
    if let Some(id) = cookie_tenant_id.map(str::trim).filter(|id| !id.is_empty()) {
        return Some(id.to_owned());
    }
    sole_tenant_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn cookie_tenant_id(headers: &HeaderMap, key: Option<&Key>) -> Option<String> {
    let key = key?;
    let jar = PrivateCookieJar::from_headers(headers, key.clone());
    let cookie = jar.get("session_user")?;
    let profile: DiscordUserProfile = serde_json::from_str(cookie.value()).ok()?;
    profile
        .tenant_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

/// Middleware: pin `DatabaseConnection` / `Permissions` / [`TenantFeatures`] to the tenant.
pub async fn resolve_tenant(
    State(registry): State<TenantRegistry>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let path = req.uri().path().to_owned();
    if skip_tenant_resolution(&path) {
        return Ok(next.run(req).await);
    }

    let headers = req.headers().clone();
    let key = req.extensions().get::<Key>().cloned();
    let from_cookie = cookie_tenant_id(&headers, key.as_ref());
    let Some(tenant_id) = resolve_tenant_id(&headers, from_cookie.as_deref(), None) else {
        return Ok(next.run(req).await);
    };

    let ctx = match registry.get_or_load(&tenant_id).await {
        Ok(ctx) => ctx,
        Err(AppError::NotFound(_)) if is_unscoped_auth_path(&path) => {
            return Ok(next.run(req).await);
        }
        Err(AppError::NotFound(_)) => {
            return Err(AppError::NotFound(format!(
                "tenant {tenant_id} is not registered"
            )));
        }
        Err(err) => return Err(err),
    };
    tracing::debug!(
        tenant_id,
        schema = %ctx.schema_name,
        "resolved tenant"
    );
    let (mut parts, body) = req.into_parts();
    parts.extensions.insert(ctx.db.clone());
    parts.extensions.insert(ctx.permissions.clone());
    parts
        .extensions
        .insert(TenantFeatures(ctx.features.clone()));
    parts
        .extensions
        .insert(CurrentTenantId(ctx.tenant_id.clone()));
    Ok(next.run(Request::from_parts(parts, body)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_migration;
    use crate::postgres::test_support::{cleanup_control_tenant, try_admin_db, unique_schema};
    use crate::postgres::{CONTROL_SCHEMA, drop_schema, ensure_schema, quote_ident};
    use axum::http::HeaderValue;

    #[test]
    fn skip_lists_health_oauth_and_platform() {
        assert!(skip_tenant_resolution("/api/health"));
        assert!(skip_tenant_resolution("/api/health/"));
        assert!(skip_tenant_resolution("/api/auth/discord/login"));
        assert!(skip_tenant_resolution("/api/auth/discord/callback"));
        assert!(skip_tenant_resolution("/api/auth/pending-tenants"));
        assert!(skip_tenant_resolution("/api/auth/select-tenant"));
        assert!(skip_tenant_resolution("/api/platform/admins/reload"));
        assert!(skip_tenant_resolution("/api/tenants/123/status"));
        assert!(skip_tenant_resolution("/api/auth/tenants"));
        assert!(skip_tenant_resolution("/api/auth/switch-tenant"));
        assert!(skip_tenant_resolution("/api/auth/registerable-guilds"));
        assert!(!skip_tenant_resolution("/api/auth/me"));
        assert!(!skip_tenant_resolution("/api/splits"));
    }

    #[test]
    fn header_wins_over_cookie_and_sole_tenant() {
        let mut headers = HeaderMap::new();
        headers.insert(GUILD_ID_HEADER, HeaderValue::from_static("guild-header"));
        let id = resolve_tenant_id(&headers, Some("guild-cookie"), Some("guild-sole"));
        assert_eq!(id.as_deref(), Some("guild-header"));
    }

    #[test]
    fn cookie_used_when_header_absent() {
        let headers = HeaderMap::new();
        let id = resolve_tenant_id(&headers, Some("guild-cookie"), Some("guild-sole"));
        assert_eq!(id.as_deref(), Some("guild-cookie"));
    }

    #[test]
    fn middleware_does_not_auto_pick_a_sole_unregistered_tenant() {
        let headers = HeaderMap::new();
        assert!(resolve_tenant_id(&headers, None, None).is_none());
    }

    #[test]
    fn missing_tenant_when_ambiguous() {
        let headers = HeaderMap::new();
        assert!(resolve_tenant_id(&headers, None, None).is_none());
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn two_tenant_pools_never_see_each_others_rows() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };

        ensure_schema(&admin, CONTROL_SCHEMA)
            .await
            .expect("control schema");
        let control = connect_with_search_path(&url, CONTROL_SCHEMA)
            .await
            .expect("control connect");
        control_migration::Migrator::up(&control, None)
            .await
            .expect("control migrations");

        let id_a = unique_schema("ta");
        let id_b = unique_schema("tb");
        let schema_a = format!("tenant_{id_a}");
        let schema_b = format!("tenant_{id_b}");

        let insert_tenant = |id: &str, schema: &str, slug: &str| {
            Statement::from_sql_and_values(
                control.get_database_backend(),
                format!(
                    "INSERT INTO {}.tenants (id, slug, name, schema_name, status) \
                     VALUES ($1, $2, $3, $4, 'active')",
                    quote_ident(CONTROL_SCHEMA)
                ),
                [id.into(), slug.into(), id.into(), schema.into()],
            )
        };
        control
            .execute(insert_tenant(&id_a, &schema_a, "slug-a"))
            .await
            .expect("insert tenant a");
        control
            .execute(insert_tenant(&id_b, &schema_b, "slug-b"))
            .await
            .expect("insert tenant b");
        ensure_schema(&admin, &schema_a).await.expect("schema a");
        ensure_schema(&admin, &schema_b).await.expect("schema b");

        let registry = TenantRegistry::new(url, control.clone(), None, None);
        let ctx_a = registry.get_or_load(&id_a).await.expect("load a");
        let ctx_b = registry.get_or_load(&id_b).await.expect("load b");
        assert_eq!(registry.cached_len(), 2);
        assert_ne!(ctx_a.schema_name, ctx_b.schema_name);
        assert!(!TenantFeatures(ctx_a.features.clone()).contains("regolamento"));

        ctx_a
            .db
            .execute_unprepared(
                "INSERT INTO users (username, email, role) \
                 VALUES ('alice', 'alice@a.test', 'User')",
            )
            .await
            .expect("insert alice");
        ctx_b
            .db
            .execute_unprepared(
                "INSERT INTO users (username, email, role) \
                 VALUES ('bob', 'bob@b.test', 'User')",
            )
            .await
            .expect("insert bob");

        let count_a: i64 = ctx_a
            .db
            .query_one(Statement::from_string(
                ctx_a.db.get_database_backend(),
                "SELECT count(*) FROM users WHERE email = 'alice@a.test'".to_owned(),
            ))
            .await
            .expect("query a")
            .expect("row a")
            .try_get_by_index(0)
            .expect("count a");
        let count_b_sees_alice: i64 = ctx_b
            .db
            .query_one(Statement::from_string(
                ctx_b.db.get_database_backend(),
                "SELECT count(*) FROM users WHERE email = 'alice@a.test'".to_owned(),
            ))
            .await
            .expect("query b")
            .expect("row b")
            .try_get_by_index(0)
            .expect("count b");
        assert_eq!(count_a, 1);
        assert_eq!(count_b_sees_alice, 0);

        drop_schema(&admin, &schema_a).await.expect("drop a");
        drop_schema(&admin, &schema_b).await.expect("drop b");
        cleanup_control_tenant(&control, &id_a, "")
            .await
            .expect("cleanup a");
        cleanup_control_tenant(&control, &id_b, "")
            .await
            .expect("cleanup b");
    }
}
