//! Per-request tenant resolution.
//!
//! A [`TenantRegistry`] caches one [`TenantContext`] per active tenant (database
//! pool pinned to that tenant's schema, permission cache, feature flags). The
//! Axum middleware reads `X-Guild-Id` or the session cookie's `tenant_id` and
//! inserts the matching `DatabaseConnection` / [`crate::modules::auth::Permissions`]
//! into request extensions so existing handlers keep their signatures.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::cookie::Key;
use dashmap::DashMap;
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use sea_orm_migration::MigratorTrait;
use subtle::ConstantTimeEq;

use crate::config::Config;
use crate::errors::AppError;
use crate::migration::Migrator;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::auth::Permissions;
use crate::modules::capabilities::{self, Enforcement};
use crate::postgres::{self, connect_tenant_pool, list_active_tenants};
use crate::{albion_scope, battle_sync, event_sessions};

/// Header the Discord bot sends to select a guild/tenant.
///
/// Only trusted alongside [`BOT_SECRET_HEADER`] — see [`resolve_tenant_id`].
pub const GUILD_ID_HEADER: &str = "X-Guild-Id";

/// Shared-secret header proving a request came from the Discord bot.
pub const BOT_SECRET_HEADER: &str = "X-Bot-Secret";

/// Control-plane pool, distinct from the per-tenant `DatabaseConnection`.
#[derive(Clone)]
pub struct ControlDb(pub DatabaseConnection);

/// Discord guild id of the tenant resolved for this request.
#[derive(Clone)]
pub struct CurrentTenantId(pub String);

/// `guild` or `alliance` for the resolved tenant.
#[derive(Clone)]
pub struct CurrentTenantKind(pub String);

/// Feature flags enabled for the current tenant.
#[derive(Clone, Debug, Default)]
pub struct TenantFeatures(pub HashSet<String>);

impl TenantFeatures {
    /// Whether `key` is enabled for this tenant.
    #[must_use]
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
    /// `guild` or `alliance`. Alliance tenants do not run battle/event workers.
    pub kind: String,
}

/// Battle-sync and event-session workers poll an Albion guild. Alliance tenants
/// have none, so they must not start.
#[must_use]
pub fn starts_sync_workers(kind: &str) -> bool {
    kind != "alliance"
}

/// The background workers every tenant needs (`event_sessions`, `battle_sync`),
/// bundled with what starting them takes.
///
/// `run_server` starts these itself for every tenant found `active` at boot,
/// by iterating [`TenantRegistry::warmup`]'s result — that loop has no reason
/// to move into the registry. This bundle exists for the tenant that shows up
/// *after* boot: [`TenantRegistry::provision`] needs the same four
/// dependencies to do the same thing for it, and can only reach them if the
/// registry is holding onto a copy.
#[derive(Clone)]
pub struct TenantWorkers {
    pub albionbb_service: AlbionBbService,
    pub albiondata_service: AlbionDataService,
}

impl TenantWorkers {
    fn spawn_for(
        &self,
        db: DatabaseConnection,
        tenant_id: &str,
        control: DatabaseConnection,
        stop: Arc<AtomicBool>,
    ) {
        event_sessions::spawn(
            db.clone(),
            self.albionbb_service.clone(),
            self.albiondata_service.clone(),
            tenant_id.to_owned(),
            control.clone(),
            stop.clone(),
        );
        battle_sync::spawn(
            db,
            self.albionbb_service.clone(),
            self.albiondata_service.clone(),
            tenant_id.to_owned(),
            control,
            stop,
        );
    }
}

/// Lazy cache of [`TenantContext`] keyed by Discord guild id.
#[derive(Clone)]
pub struct TenantRegistry {
    database_url: String,
    control_db: DatabaseConnection,
    inner: Arc<DashMap<String, Arc<TenantContext>>>,
    /// One async gate per tenant, held while its first load runs. Concurrent first
    /// requests (and a warmup racing a request) wait for the winner instead of each
    /// opening a pool and running `Migrator::up` in parallel.
    loading: Arc<DashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Set once by `run_server` before it starts serving traffic. `OnceLock`
    /// rather than a mutable field: every clone of the registry — one per
    /// request, via the `Extension` layer — shares the same slot, and nothing
    /// after startup ever needs to change which services `provision` uses.
    workers: Arc<OnceLock<TenantWorkers>>,
    /// Tenants whose sync tasks are already running. The flag stops them when
    /// the tenant is suspended; reactivation starts a new pair.
    running_sync: Arc<DashMap<String, Arc<AtomicBool>>>,
    /// Bumped for a tenant by [`Self::evict`] and [`Self::refresh`]. A load or refresh
    /// reads this before it reads the control plane and caches its result only if the
    /// value is unchanged, so an invalidation that overlaps the read cannot leave the
    /// read's (possibly pre-suspension) state in the cache.
    epochs: Arc<DashMap<String, u64>>,
}

impl TenantRegistry {
    /// Build an empty registry. Call [`Self::warmup`] before serving traffic,
    /// and [`Self::set_workers`] before any request can reach
    /// [`Self::provision`].
    #[must_use]
    pub fn new(database_url: String, control_db: DatabaseConnection) -> Self {
        Self {
            database_url,
            control_db,
            inner: Arc::new(DashMap::new()),
            loading: Arc::new(DashMap::new()),
            workers: Arc::new(OnceLock::new()),
            running_sync: Arc::new(DashMap::new()),
            epochs: Arc::new(DashMap::new()),
        }
    }

    /// Starts event and battle sync once per guild tenant.
    ///
    /// No-ops for alliance tenants, when [`Self::set_workers`] has not run, and
    /// when a pair is already running. Each tick re-reads Albion settings and
    /// skips work unless the tenant is `active`.
    pub async fn ensure_sync_workers(&self, db: DatabaseConnection, tenant_id: &str, kind: &str) {
        if !starts_sync_workers(kind) {
            return;
        }
        let Some(workers) = self.workers.get() else {
            return;
        };
        if self.running_sync.contains_key(tenant_id) {
            return;
        }
        let Ok(status_before) = self.tenant_status(tenant_id).await else {
            return;
        };
        if !albion_scope::worker_start_allowed(&status_before, &status_before) {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        match self.running_sync.entry(tenant_id.to_owned()) {
            dashmap::mapref::entry::Entry::Occupied(_) => return,
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(stop.clone());
            }
        }
        let status_after = self.tenant_status(tenant_id).await.unwrap_or_default();
        if !albion_scope::worker_start_allowed(&status_before, &status_after) {
            stop.store(true, Ordering::Relaxed);
            self.running_sync
                .remove_if(tenant_id, |_, current| Arc::ptr_eq(current, &stop));
            tracing::info!(tenant_id, "sync workers not started; tenant is not active");
            return;
        }
        tracing::info!(tenant_id, kind, "starting per-tenant sync workers");
        workers.spawn_for(db, tenant_id, self.control_db.clone(), stop);
    }

    async fn tenant_status(&self, tenant_id: &str) -> Result<String, AppError> {
        let row = self
            .control_db
            .query_one(Statement::from_sql_and_values(
                self.control_db.get_database_backend(),
                "SELECT status FROM tenants WHERE id = $1",
                [tenant_id.into()],
            ))
            .await
            .map_err(AppError::Database)?;
        let Some(row) = row else {
            return Err(AppError::NotFound(format!(
                "tenant {tenant_id} is not registered"
            )));
        };
        row.try_get_by_index(0).map_err(AppError::Database)
    }

    /// Asks the tenant's sync tasks to exit. The next [`Self::ensure_sync_workers`]
    /// starts a fresh pair. In-flight ticks are not cancelled.
    pub fn stop_sync_workers(&self, tenant_id: &str) {
        if let Some((_, stop)) = self.running_sync.remove(tenant_id) {
            stop.store(true, Ordering::Relaxed);
            tracing::info!(tenant_id, "stopping per-tenant sync workers");
        }
    }

    /// Supplies the dependencies [`Self::provision`] needs to start a freshly
    /// registered tenant's background workers.
    ///
    /// A tenant that registers today has no reason to wait for a restart
    /// before its event auto-stop and battle sync start running — but without
    /// this, `provision` had no way to reach `event_sessions`/`battle_sync`'s
    /// dependencies at all, so it silently never started them. Call once,
    /// before the server accepts its first request; later calls are ignored
    /// (see [`OnceLock::set`]).
    pub fn set_workers(&self, workers: TenantWorkers) {
        let _ = self.workers.set(workers);
    }

    /// Load every active tenant so workers can start.
    ///
    /// # Errors
    ///
    /// Returns a database error if a tenant schema cannot be opened or migrated.
    pub async fn warmup(&self) -> Result<Vec<Arc<TenantContext>>, AppError> {
        let active = list_active_tenants(&self.control_db)
            .await
            .map_err(AppError::Database)?;
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

    /// Return a cached context, loading it on first use.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the tenant is missing or not `active`,
    /// or a database error if the schema cannot be opened.
    pub async fn get_or_load(&self, tenant_id: &str) -> Result<Arc<TenantContext>, AppError> {
        self.load_once(tenant_id, || self.load(tenant_id)).await
    }

    /// Runs `load` at most once per tenant at a time (single-flight).
    ///
    /// Callers that find the context cached return it without taking the gate. The
    /// rest queue on the tenant's gate, and the first one through re-checks the cache
    /// so a load that finished while it waited is reused, not repeated.
    async fn load_once<F, Fut>(
        &self,
        tenant_id: &str,
        load: F,
    ) -> Result<Arc<TenantContext>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Arc<TenantContext>, AppError>>,
    {
        if let Some(ctx) = self.inner.get(tenant_id) {
            return Ok(ctx.clone());
        }
        // The map entry guard is a temporary: it is dropped before the await below.
        let gate = self
            .loading
            .entry(tenant_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .value()
            .clone();
        let _turn = gate.lock().await;
        if let Some(ctx) = self.inner.get(tenant_id) {
            return Ok(ctx.clone());
        }
        let epoch = self.epoch(tenant_id);
        let ctx = load().await?;
        self.publish(tenant_id, epoch, &ctx);
        Ok(ctx)
    }

    /// Caches a ready-made context so tests can address tenants without control rows.
    #[cfg(test)]
    pub(crate) fn cache_context_for_tests(&self, ctx: Arc<TenantContext>) {
        self.inner.insert(ctx.tenant_id.clone(), ctx);
    }

    /// Drop a cached context so the next request reloads flags, status, and pool.
    ///
    /// Use this only when the tenant itself stops being served (suspension, archive).
    /// Feature, rank and permission changes call [`Self::refresh`] instead: evicting
    /// there leaked the old pool while its workers still used it, and reconnected
    /// and re-ran migrations on the next request.
    ///
    /// The epoch is bumped before the entry is removed, so a load that is still
    /// reading the control plane cannot cache its result afterwards.
    pub fn evict(&self, tenant_id: &str) {
        self.invalidate(tenant_id);
        self.inner.remove(tenant_id);
    }

    /// Re-reads feature flags, status and the permission snapshot of a cached tenant,
    /// keeping its pool.
    ///
    /// The pool and the background workers that hold it stay as they are: no reconnect,
    /// no migration check. A tenant that is no longer `active` is evicted, so the next
    /// request is refused exactly as a cold load would be. A failed reload also evicts,
    /// which falls back to the cold path rather than serving stale flags.
    ///
    /// The tenant is invalidated even when nothing is cached, so a cold load that
    /// overlaps this call does not cache the flags it read before the write.
    pub async fn refresh(&self, tenant_id: &str) {
        self.invalidate(tenant_id);
        let epoch = self.epoch(tenant_id);
        let Some(current) = self
            .inner
            .get(tenant_id)
            .map(|entry| Arc::clone(entry.value()))
        else {
            // Nothing cached: the next request reads the new state anyway.
            return;
        };
        match self.reload_context(&current).await {
            Ok(Some(fresh)) => self.publish(tenant_id, epoch, &Arc::new(fresh)),
            Ok(None) => self.evict(tenant_id),
            Err(err) => {
                tracing::warn!(
                    tenant_id,
                    error = ?err,
                    "tenant refresh failed; evicting so the next request reloads"
                );
                self.evict(tenant_id);
            }
        }
    }

    /// The current invalidation epoch of `tenant_id`. Read it before reading the
    /// control plane, and pass it to [`Self::publish`].
    fn epoch(&self, tenant_id: &str) -> u64 {
        self.epochs.get(tenant_id).map_or(0, |epoch| *epoch)
    }

    fn invalidate(&self, tenant_id: &str) {
        *self.epochs.entry(tenant_id.to_owned()).or_insert(0) += 1;
    }

    /// Caches `ctx` unless the tenant was invalidated since `epoch` was read.
    ///
    /// Insert first, then check: an invalidation that lands after the check finds
    /// `ctx` in the map and removes it, because it bumps the epoch before it removes.
    /// An invalidation that landed before the check is caught here.
    fn publish(&self, tenant_id: &str, epoch: u64, ctx: &Arc<TenantContext>) {
        self.inner.insert(tenant_id.to_owned(), Arc::clone(ctx));
        if self.epoch(tenant_id) != epoch {
            self.inner
                .remove_if(tenant_id, |_, cached| Arc::ptr_eq(cached, ctx));
        }
    }

    /// Builds the refreshed context for `current`, sharing its pool and permission cache.
    ///
    /// `Ok(None)` when the tenant is no longer active or no longer registered.
    async fn reload_context(
        &self,
        current: &TenantContext,
    ) -> Result<Option<TenantContext>, AppError> {
        let row = self
            .control_db
            .query_one(Statement::from_sql_and_values(
                self.control_db.get_database_backend(),
                "SELECT status FROM tenants WHERE id = $1",
                [current.tenant_id.as_str().into()],
            ))
            .await
            .map_err(AppError::Database)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let status: String = row.try_get_by_index(0).map_err(AppError::Database)?;
        if status != "active" {
            return Ok(None);
        }
        current
            .permissions
            .reload(&current.db)
            .await
            .map_err(AppError::Database)?;
        let features = load_features(&self.control_db, &current.tenant_id).await?;
        let kind = lookup_tenant_kind(&self.control_db, &current.tenant_id).await?;
        Ok(Some(TenantContext {
            tenant_id: current.tenant_id.clone(),
            schema_name: current.schema_name.clone(),
            db: current.db.clone(),
            permissions: current.permissions.clone(),
            features,
            kind,
        }))
    }

    /// Create the Postgres schema, run tenant migrations, cache the context,
    /// and start its background workers.
    ///
    /// Used when provisioning a brand-new tenant (row may still be
    /// `provisioning`). Every *other* active tenant gets `event_sessions` and
    /// `battle_sync` from `run_server`'s own startup loop, which iterates
    /// [`Self::warmup`]'s result — a tenant provisioned after that loop ran
    /// has no other path to them.
    ///
    /// # Errors
    ///
    /// Returns a database error if the schema cannot be created or migrated.
    pub async fn provision(
        &self,
        tenant_id: &str,
        schema_name: &str,
    ) -> Result<Arc<TenantContext>, AppError> {
        // Tenant schemas live on `database_url`. `control_db` may point at a
        // different cluster when `CONTROL_DATABASE_URL` is set, and creating
        // the schema there would leave the tenant pool unable to see it.
        let admin = sea_orm::Database::connect(&self.database_url)
            .await
            .map_err(AppError::Database)?;
        postgres::ensure_schema(&admin, schema_name)
            .await
            .map_err(AppError::Database)?;
        let epoch = self.epoch(tenant_id);
        let ctx = self.open_context(tenant_id, schema_name).await?;
        self.publish(tenant_id, epoch, &ctx);
        if self.workers.get().is_none() {
            // Should not happen outside of tests: `run_server` calls
            // `set_workers` before the router can accept a request that
            // reaches here. Proceeding without workers over failing the
            // registration outright — a tenant that exists but is not yet
            // auto-stopping sessions is recoverable with a restart; one that
            // never got created is not.
            tracing::warn!(
                tenant_id,
                "tenant provisioned with no worker dependencies configured; \
                 event_sessions/battle_sync will not run for it until the next restart"
            );
        } else {
            let kind = lookup_tenant_kind(&self.control_db, tenant_id).await?;
            self.ensure_sync_workers(ctx.db.clone(), tenant_id, &kind)
                .await;
        }
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

    async fn open_context(
        &self,
        tenant_id: &str,
        schema_name: &str,
    ) -> Result<Arc<TenantContext>, AppError> {
        let db = connect_tenant_pool(&self.database_url, schema_name)
            .await
            .map_err(AppError::Database)?;
        Migrator::up(&db, None).await.map_err(AppError::Database)?;
        let permissions = Permissions::new_empty();
        permissions.reload(&db).await.map_err(AppError::Database)?;
        let features = load_features(&self.control_db, tenant_id).await?;
        let kind = lookup_tenant_kind(&self.control_db, tenant_id).await?;
        Ok(Arc::new(TenantContext {
            tenant_id: tenant_id.to_owned(),
            schema_name: schema_name.to_owned(),
            db,
            permissions,
            features,
            kind,
        }))
    }
}

async fn lookup_tenant_kind(
    control_db: &DatabaseConnection,
    tenant_id: &str,
) -> Result<String, AppError> {
    let row = control_db
        .query_one(Statement::from_sql_and_values(
            control_db.get_database_backend(),
            "SELECT kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let Some(row) = row else {
        return Err(AppError::NotFound(format!(
            "tenant {tenant_id} is not registered"
        )));
    };
    let kind: String = row.try_get_by_index(0).map_err(AppError::Database)?;
    if kind.is_empty() {
        return Err(AppError::Database(sea_orm::DbErr::Custom(format!(
            "tenant {tenant_id} has no kind"
        ))));
    }
    Ok(kind)
}

pub(crate) async fn load_features(
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
        || path == "/api/openapi.json"
        || path == "/api/auth/discord/login"
        || path == "/api/auth/discord/callback"
        || path == "/api/auth/pending-tenants"
        || path == "/api/auth/select-tenant"
        || path.starts_with("/api/platform")
        || path.starts_with("/api/tenants")
        // Most alliance membership endpoints only use the control plane, but
        // the role-patching endpoint also checks the currently selected
        // tenant/kind. Do not skip tenant resolution for that route.
        || path == "/api/alliances/me"
        || (path.starts_with("/api/alliances/")
            && (path.ends_with("/members") || path.ends_with("/accept")))
        || path == "/api/auth/tenants"
        || path == "/api/auth/switch-tenant"
        || path == "/api/auth/registerable-guilds"
        || path == "/api/auth/bot-invite"
}

/// API prefixes that belong to an optional module, and the feature key that
/// unlocks them.
///
/// This mirrors the `featureKey` entries the web client uses to hide nav items:
/// hiding a link is a convenience, not a control, and without this table anyone
/// who knows the URL reaches a module the tenant's Rank never granted.
///
/// Order matters — the first match wins, so a narrower prefix has to come before
/// the broader one it sits inside. Only what the client gates is gated here: a
/// prefix that also backs an always-available page must not be listed, or that
/// page breaks for tenants without the module.
pub(crate) const FEATURE_GATES: &[(&str, &str)] = &[
    // Paid splits: islands are the gated part, the rest of `/api/splits` is not.
    ("/api/splits/islands", "splits.paid"),
    ("/api/splits", "splits"),
    // Only the tests console is gated. The rest of `/api/combat` — item power,
    // simulation, mastery data — backs the comps and builds pages.
    ("/api/combat/tests", "tests"),
    ("/api/combat/runs", "tests"),
    // The dashboard and `/season` read `/api/progression/{me,leaderboard,seasons}`
    // and are never feature-gated in the client, so only the settings owned by
    // the gated admin panel are gated here.
    ("/api/progression/settings", "progression"),
    ("/api/applications", "applications"),
    ("/api/bank", "bank"),
    ("/api/battles", "battles"),
    // Fights are the drill-down of a battle and have no module of their own.
    ("/api/fights", "battles"),
    // Economy views are a drill-down of battle/fight evidence and have no module of their own.
    ("/api/economy", "battles"),
    // Fight analytics are another drill-down of battle/fight evidence with no module of their own.
    ("/api/fight-analytics", "battles"),
    ("/api/comps", "comps"),
    ("/api/events", "events"),
    ("/api/giveaways", "giveaways"),
    ("/api/intel", "intel"),
    // Enemy guild/player dossiers are a drill-down of intel and have no module of their own.
    ("/api/enemies", "intel"),
    // Equipment fingerprints are another drill-down of intel with no module of their own.
    ("/api/fingerprints", "intel"),
    // Attention findings are another drill-down of intel with no module of their own.
    ("/api/attention", "intel"),
    ("/api/regear", "regears"),
    ("/api/siphoned", "siphoned"),
    ("/api/warns", "warns"),
];

/// The feature key `path` requires, if it belongs to an optional module.
///
/// Matches on whole path segments so `/api/compsomething` never counts as
/// `/api/comps`.
fn required_feature(path: &str) -> Option<&'static str> {
    let path = path.trim_end_matches('/');
    FEATURE_GATES
        .iter()
        .find(|(prefix, _)| {
            path == *prefix
                || path
                    .strip_prefix(*prefix)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
        .map(|(_, feature)| *feature)
}

/// Module access for one request: the kind rule, then the legacy feature table.
///
/// The kind rule runs first because it gives the precise reason
/// (`module_unavailable` / `kind_unsupported`). Checking the feature first would
/// answer an alliance request for a guild-only module with the legacy 403 and no
/// `code`, so enforce mode would never report it.
fn check_module_access(
    path: &str,
    kind: &str,
    features: &TenantFeatures,
    enforcement: Enforcement,
) -> Result<(), AppError> {
    capabilities::kind_gate(path, kind, enforcement)?;
    if let Some(feature) = required_feature(path) {
        let alliance_bank = feature == "bank" && kind == "alliance";
        if !features.contains(feature) && !alliance_bank {
            return Err(AppError::Forbidden(format!(
                "the {feature} module is not enabled for this guild"
            )));
        }
    }
    Ok(())
}

/// Whether a handler on `path` needs a tenant database bound to the request.
///
/// False for the unscoped auth endpoints (they take an `Option<Extension<_>>`)
/// and for anything outside `/api`, such as the `/scalar` API reference.
fn needs_tenant(path: &str) -> bool {
    path.starts_with("/api") && !is_unscoped_auth_path(path)
}

fn is_unscoped_auth_path(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path == "/api/auth/me"
        || path == "/api/auth/logout"
        || path == "/api/auth/tenants"
        || path == "/api/auth/registerable-guilds"
        || path == "/api/auth/bot-invite"
}

/// Whether this request proved it is the Discord bot.
///
/// The bot is the only caller allowed to name a guild it is not signed into,
/// because it holds `BOT_API_SECRET` and speaks for every tenant it serves.
/// A browser session names its guild through the cookie instead, which the
/// user cannot rewrite.
fn is_bot_request(headers: &HeaderMap, cfg: Option<&Config>) -> bool {
    let Some(expected) = cfg.and_then(Config::bot_secret) else {
        return false;
    };
    let Some(provided) = headers
        .get(BOT_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    // Constant-time, for the same reason `UserContext` compares it that way:
    // an early-exit `!=` leaks the mismatch position.
    provided.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// Resolve a tenant id from the bot header or the session cookie.
///
/// `X-Guild-Id` is honoured **only** when `header_is_trusted` — that is, when
/// the request carried a valid `X-Bot-Secret`. For a cookie session the header
/// is inert: it is user-controlled, and a session's roles are role *names*
/// resolved against whichever tenant is loaded, so letting the header pick the
/// tenant would let any member of one guild inherit the same-named role in
/// every other guild. The web client never sends it.
///
/// There is deliberately no "if there is only one tenant, use it" branch: a
/// caller that names no guild is a caller with a bug, and guessing one would
/// silently serve one tenant's data to a request meant for another.
#[must_use]
pub fn resolve_tenant_id(
    headers: &HeaderMap,
    cookie_tenant_id: Option<&str>,
    header_is_trusted: bool,
) -> Option<String> {
    if header_is_trusted
        && let Some(id) = headers
            .get(GUILD_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Some(id.to_owned());
    }
    cookie_tenant_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn cookie_tenant_id(headers: &HeaderMap, key: Option<&Key>) -> Option<String> {
    // Only picks which tenant's pool the request runs against. It deliberately does not
    // consult the session store: authentication is the extractors' job, and an unauthenticated
    // request with a stale cookie is refused there.
    let session = crate::modules::auth::session_store::SessionCookie::from_headers(headers, key?)?;
    session
        .profile
        .tenant_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

/// The tenant this request is allowed to address.
///
/// Split out of [`resolve_tenant`] so it can be exercised through a real
/// router: the answer depends on `Config` and `Key` being present in the
/// request extensions, which is a property of the layer order in `lib.rs`, not
/// of this function.
fn tenant_for_request(
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
    path: &str,
) -> Option<String> {
    let key = extensions.get::<Key>().cloned();
    let from_cookie = cookie_tenant_id(headers, key.as_ref());
    let trust_header = is_bot_request(headers, extensions.get::<Config>());
    if !trust_header
        && let Some(requested) = headers
            .get(GUILD_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        && Some(requested) != from_cookie.as_deref()
    {
        // Not an error — the request still runs against the session's own
        // tenant — but nothing legitimate sends this, so it is worth seeing.
        tracing::warn!(
            requested_tenant = requested,
            session_tenant = from_cookie.as_deref().unwrap_or("<none>"),
            path,
            "ignoring {GUILD_ID_HEADER} on a request that is not bot-authenticated"
        );
    }
    resolve_tenant_id(headers, from_cookie.as_deref(), trust_header)
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
    let Some(tenant_id) = tenant_for_request(&headers, req.extensions(), &path) else {
        if needs_tenant(&path) {
            // No tenant, so no database is bound to this request. Handlers
            // destructure `Extension(db)`, so letting it through would trade a
            // clear error for Axum's bare 500 on a missing extension — which is
            // what a client that forgot `X-Guild-Id` sees on *every* endpoint,
            // with nothing in the message to say why.
            return Err(AppError::Validation(format!(
                "no tenant for {path}: send the {GUILD_ID_HEADER} header, \
                 or sign in and select a guild"
            )));
        }
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
    let features = TenantFeatures(ctx.features.clone());
    let enforcement = req
        .extensions()
        .get::<Config>()
        .map_or(Enforcement::Log, |cfg| {
            Enforcement::parse(&cfg.module_kind_enforcement)
        });
    check_module_access(&path, &ctx.kind, &features, enforcement)?;
    let version = capabilities::tenant_version(&ctx.kind, "active", &ctx.features);

    let (mut parts, body) = req.into_parts();
    parts.extensions.insert(ctx.db.clone());
    parts.extensions.insert(ctx.permissions.clone());
    parts.extensions.insert(features);
    parts
        .extensions
        .insert(CurrentTenantId(ctx.tenant_id.clone()));
    parts.extensions.insert(CurrentTenantKind(ctx.kind.clone()));
    let mut response = next.run(Request::from_parts(parts, body)).await;
    if let Ok(value) = axum::http::HeaderValue::from_str(&version) {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(capabilities::router::CAPABILITIES_VERSION_HEADER),
            value,
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_migration;
    use crate::postgres::test_support::{cleanup_control_tenant, try_admin_db, unique_schema};
    use crate::postgres::{
        CONTROL_SCHEMA, connect_with_search_path, drop_schema, ensure_schema, quote_ident,
    };
    use axum::http::HeaderValue;
    use axum::response::IntoResponse;

    #[test]
    fn feature_gate_matches_whole_segments_only() {
        assert_eq!(required_feature("/api/comps"), Some("comps"));
        assert_eq!(required_feature("/api/comps/"), Some("comps"));
        assert_eq!(required_feature("/api/comps/12/builds"), Some("comps"));
        // A longer name that merely starts with a gated prefix is not that module.
        assert_eq!(required_feature("/api/compsomething"), None);
        assert_eq!(required_feature("/api/bankruptcy"), None);
    }

    #[test]
    fn feature_gate_prefers_the_narrower_prefix() {
        assert_eq!(required_feature("/api/splits"), Some("splits"));
        assert_eq!(required_feature("/api/splits/42/complete"), Some("splits"));
        assert_eq!(required_feature("/api/splits/islands"), Some("splits.paid"));
        assert_eq!(
            required_feature("/api/splits/islands/7/tabs"),
            Some("splits.paid")
        );
    }

    #[test]
    fn kind_rule_refuses_before_the_feature_table_does() {
        let none = TenantFeatures::default();
        let warns = TenantFeatures(HashSet::from(["warns".to_owned()]));

        // Enforce: the kind reason wins even with the flag on or off.
        for features in [&none, &warns] {
            let err = check_module_access("/api/warns", "alliance", features, Enforcement::Enforce)
                .expect_err("enforce refuses a guild-only module for an alliance");
            assert!(
                matches!(err, AppError::ModuleUnavailable { .. }),
                "expected module_unavailable, got {err:?}"
            );
        }

        // Log: the request goes through once the legacy feature passes.
        assert!(check_module_access("/api/warns", "alliance", &warns, Enforcement::Log).is_ok());
        // A guild without the flag keeps the legacy 403.
        assert!(matches!(
            check_module_access("/api/warns", "guild", &none, Enforcement::Log),
            Err(AppError::Forbidden(_))
        ));
        // The alliance bank needs no feature flag.
        assert!(
            check_module_access("/api/bank/balance", "alliance", &none, Enforcement::Enforce)
                .is_ok()
        );
    }

    #[test]
    fn feature_gate_leaves_always_available_endpoints_open() {
        // `/season`, the dashboard and the leaderboards are never gated in the
        // client, so the progression endpoints they read must stay reachable.
        assert_eq!(required_feature("/api/progression/me"), None);
        assert_eq!(required_feature("/api/progression/leaderboard"), None);
        assert_eq!(required_feature("/api/progression/seasons"), None);
        assert_eq!(
            required_feature("/api/progression/settings"),
            Some("progression")
        );
        // Item power and simulation back the comps pages, not the tests console.
        assert_eq!(required_feature("/api/combat/item-power"), None);
        assert_eq!(required_feature("/api/combat/simulate"), None);
        assert_eq!(required_feature("/api/combat/tests/3/run"), Some("tests"));
        // Session, admin and platform surfaces are never module-gated.
        assert_eq!(required_feature("/api/auth/me"), None);
        assert_eq!(required_feature("/api/admin/roles"), None);
        assert_eq!(required_feature("/api/users/me/metrics"), None);
    }

    #[test]
    fn feature_gate_covers_every_key_the_client_gates() {
        // Keys come from `APP_NAV_SECTIONS` / `ADMIN_PANELS` in the web client's
        // `layout/nav.ts`. A key the client hides but the server serves is the
        // hole this table exists to close.
        for key in [
            "applications",
            "bank",
            "battles",
            "comps",
            "events",
            "giveaways",
            "intel",
            "progression",
            "regears",
            "siphoned",
            "splits",
            "splits.paid",
            "tests",
            "warns",
        ] {
            assert!(
                FEATURE_GATES.iter().any(|(_, feature)| *feature == key),
                "no server-side gate for the {key} module"
            );
        }
    }

    #[test]
    fn alliance_kind_does_not_start_sync_workers() {
        assert!(starts_sync_workers("guild"));
        assert!(!starts_sync_workers("alliance"));
    }

    #[test]
    fn skip_lists_health_oauth_and_platform() {
        assert!(skip_tenant_resolution("/api/health"));
        assert!(skip_tenant_resolution("/api/health/"));
        assert!(skip_tenant_resolution("/api/openapi.json"));
        assert!(skip_tenant_resolution("/api/auth/discord/login"));
        assert!(skip_tenant_resolution("/api/auth/discord/callback"));
        assert!(skip_tenant_resolution("/api/auth/pending-tenants"));
        assert!(skip_tenant_resolution("/api/auth/select-tenant"));
        assert!(skip_tenant_resolution("/api/platform/admins/reload"));
        assert!(skip_tenant_resolution("/api/tenants/123/status"));
        assert!(skip_tenant_resolution("/api/alliances/me"));
        assert!(skip_tenant_resolution("/api/alliances/123/members"));
        assert!(skip_tenant_resolution(
            "/api/alliances/123/members/456/accept"
        ));
        assert!(!skip_tenant_resolution("/api/alliances/123/members/456"));
        assert!(skip_tenant_resolution("/api/auth/tenants"));
        assert!(skip_tenant_resolution("/api/auth/switch-tenant"));
        assert!(skip_tenant_resolution("/api/auth/registerable-guilds"));
        assert!(skip_tenant_resolution("/api/auth/bot-invite"));
        assert!(!skip_tenant_resolution("/api/auth/me"));
        assert!(!skip_tenant_resolution("/api/splits"));
    }

    #[test]
    fn only_api_paths_outside_the_unscoped_auth_set_need_a_tenant() {
        assert!(needs_tenant("/api/splits"));
        assert!(needs_tenant("/api/admin/settings"));
        assert!(!needs_tenant("/api/auth/me"));
        assert!(!needs_tenant("/api/auth/logout"));
        // The API reference is served outside `/api` and must stay reachable
        // without a guild.
        assert!(!needs_tenant("/scalar"));
    }

    #[test]
    fn header_wins_over_cookie_for_the_bot() {
        let mut headers = HeaderMap::new();
        headers.insert(GUILD_ID_HEADER, HeaderValue::from_static("guild-header"));
        let id = resolve_tenant_id(&headers, Some("guild-cookie"), true);
        assert_eq!(id.as_deref(), Some("guild-header"));
    }

    /// The escalation this gate exists to stop: role names are shared across
    /// tenant schemas, so a session that could name any guild would inherit the
    /// same-named role's permissions in every other guild.
    #[test]
    fn header_is_ignored_for_a_cookie_session() {
        let mut headers = HeaderMap::new();
        headers.insert(GUILD_ID_HEADER, HeaderValue::from_static("victim-guild"));
        let id = resolve_tenant_id(&headers, Some("guild-cookie"), false);
        assert_eq!(id.as_deref(), Some("guild-cookie"));
    }

    /// A session with no tenant cannot borrow one from the header either.
    #[test]
    fn untrusted_header_alone_resolves_nothing() {
        let mut headers = HeaderMap::new();
        headers.insert(GUILD_ID_HEADER, HeaderValue::from_static("victim-guild"));
        assert!(resolve_tenant_id(&headers, None, false).is_none());
    }

    #[test]
    fn cookie_used_when_header_absent() {
        let headers = HeaderMap::new();
        let id = resolve_tenant_id(&headers, Some("guild-cookie"), true);
        assert_eq!(id.as_deref(), Some("guild-cookie"));
    }

    #[test]
    fn no_tenant_is_ever_guessed() {
        let headers = HeaderMap::new();
        assert!(resolve_tenant_id(&headers, None, true).is_none());
        // A blank header or cookie is "unset", never an empty tenant id.
        let mut blank = HeaderMap::new();
        blank.insert(GUILD_ID_HEADER, HeaderValue::from_static("  "));
        assert!(resolve_tenant_id(&blank, Some(" "), true).is_none());
    }

    fn cfg_with_bot_secret(secret: Option<&str>) -> Config {
        Config {
            backend_port: 3000,
            database_url: "postgres://localhost/weaklings".to_owned(),
            control_database_url: None,
            discord_client_id: "id".to_owned(),
            discord_client_secret: "secret".to_owned(),
            discord_redirect_uri: "http://localhost/callback".to_owned(),
            bot_api_secret: secret.map(ToOwned::to_owned),
            discord_bot_token: None,
            discord_api_base: "http://127.0.0.1:1/api/v10".to_owned(),
            discord_api_timeout_secs: 10,
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
            module_kind_enforcement: "log".to_owned(),
        }
    }

    #[test]
    fn only_the_matching_bot_secret_is_trusted() {
        let cfg = cfg_with_bot_secret(Some("s3cret"));

        let mut good = HeaderMap::new();
        good.insert(BOT_SECRET_HEADER, HeaderValue::from_static("s3cret"));
        assert!(is_bot_request(&good, Some(&cfg)));

        let mut wrong = HeaderMap::new();
        wrong.insert(BOT_SECRET_HEADER, HeaderValue::from_static("nope"));
        assert!(!is_bot_request(&wrong, Some(&cfg)));

        // A prefix of the real secret must not pass either.
        let mut prefix = HeaderMap::new();
        prefix.insert(BOT_SECRET_HEADER, HeaderValue::from_static("s3c"));
        assert!(!is_bot_request(&prefix, Some(&cfg)));

        assert!(!is_bot_request(&HeaderMap::new(), Some(&cfg)));
    }

    /// Drives [`tenant_for_request`] through a router layered exactly the way
    /// `lib.rs` layers `resolve_tenant`, and answers with the tenant it picked.
    ///
    /// The layer order is the whole point: `Config` and `Key` are added *after*
    /// the tenant middleware in source order, and only Axum's bottom-up layer
    /// application makes them visible to it. Get that wrong and `is_bot_request`
    /// silently answers `false` for every request — which would not fail any of
    /// the unit tests above, but would take the Discord bot completely offline.
    async fn resolved_tenant_through_router(
        request: axum::http::Request<axum::body::Body>,
        cfg: Config,
        key: Key,
    ) -> String {
        use tower::ServiceExt;

        async fn echo(req: Request, _next: Next) -> Response {
            let path = req.uri().path().to_owned();
            let answer = tenant_for_request(req.headers(), req.extensions(), &path)
                .unwrap_or_else(|| "<none>".to_owned());
            answer.into_response()
        }

        let app = axum::Router::new()
            .route("/api/probe", axum::routing::get(|| async { "unused" }))
            .layer(axum::middleware::from_fn(echo))
            .layer(axum::Extension(cfg))
            .layer(axum::Extension(key));

        let response = app.oneshot(request).await.expect("router responds");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        String::from_utf8(body.to_vec()).expect("utf-8 body")
    }

    fn session_cookie_for(key: &Key, tenant_id: &str) -> String {
        let profile = serde_json::json!({
            "id": "111",
            "username": "bob",
            "email": null,
            "avatar": null,
            "roles": ["Officer"],
            "highest_role": "Officer",
            "user_id": 1,
            "tenant_id": tenant_id,
        });
        crate::modules::auth::session_store::test_cookie_header(key, "test-sid", &profile)
    }

    /// The bot keeps working: its header still selects the guild it serves.
    #[tokio::test]
    async fn bot_request_still_selects_the_guild_from_the_header() {
        let key = Key::generate();
        let request = axum::http::Request::builder()
            .uri("/api/probe")
            .header(BOT_SECRET_HEADER, "s3cret")
            .header(GUILD_ID_HEADER, "guild-b")
            .body(axum::body::Body::empty())
            .expect("request");
        let resolved =
            resolved_tenant_through_router(request, cfg_with_bot_secret(Some("s3cret")), key).await;
        assert_eq!(resolved, "guild-b");
    }

    /// The escalation, end to end: a real session cookie for guild A plus an
    /// `X-Guild-Id` naming guild B still lands on guild A.
    #[tokio::test]
    async fn cookie_session_cannot_reach_another_guild_through_the_header() {
        let key = Key::generate();
        let cookie = session_cookie_for(&key, "guild-a");
        let request = axum::http::Request::builder()
            .uri("/api/probe")
            .header(axum::http::header::COOKIE, cookie)
            .header(GUILD_ID_HEADER, "guild-b")
            .body(axum::body::Body::empty())
            .expect("request");
        let resolved =
            resolved_tenant_through_router(request, cfg_with_bot_secret(Some("s3cret")), key).await;
        assert_eq!(resolved, "guild-a");
    }

    /// A wrong secret is not a bot, even with the header present.
    #[tokio::test]
    async fn a_forged_bot_secret_does_not_unlock_the_header() {
        let key = Key::generate();
        let cookie = session_cookie_for(&key, "guild-a");
        let request = axum::http::Request::builder()
            .uri("/api/probe")
            .header(axum::http::header::COOKIE, cookie)
            .header(BOT_SECRET_HEADER, "wrong")
            .header(GUILD_ID_HEADER, "guild-b")
            .body(axum::body::Body::empty())
            .expect("request");
        let resolved =
            resolved_tenant_through_router(request, cfg_with_bot_secret(Some("s3cret")), key).await;
        assert_eq!(resolved, "guild-a");
    }

    #[test]
    fn bot_auth_is_closed_when_no_secret_is_configured() {
        // With `BOT_API_SECRET` unset, bot header auth is disabled entirely —
        // an attacker must not be able to unlock the guild header by sending a
        // blank secret against a blank config.
        let cfg = cfg_with_bot_secret(None);
        let mut headers = HeaderMap::new();
        headers.insert(BOT_SECRET_HEADER, HeaderValue::from_static(""));
        assert!(!is_bot_request(&headers, Some(&cfg)));
        assert!(!is_bot_request(&headers, None));
    }

    /// `BOT_API_SECRET=` (set but empty) is what `envy` and an undefined
    /// `${BOT_API_SECRET}` in docker-compose produce. It must disable bot auth,
    /// not become a secret that an empty `X-Bot-Secret:` header matches.
    #[test]
    fn a_blank_configured_secret_never_matches_a_blank_header() {
        for blank in ["", "   "] {
            let cfg = cfg_with_bot_secret(Some(blank));
            for header in ["", "   ", blank] {
                let mut headers = HeaderMap::new();
                headers.insert(
                    BOT_SECRET_HEADER,
                    HeaderValue::from_str(header).expect("header value"),
                );
                assert!(
                    !is_bot_request(&headers, Some(&cfg)),
                    "config {blank:?} + header {header:?} must not authenticate"
                );
            }
        }
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

        let registry = TenantRegistry::new(url, control.clone());
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

    /// `provision` must not fail a brand-new tenant's creation just because no
    /// one wired up `set_workers` yet — it should register successfully and
    /// only warn, so the tenant is recoverable with a restart instead of
    /// simply not existing. This is the state every `TenantRegistry` starts
    /// in, and the state tests build one in without ever calling
    /// `set_workers` (see `two_tenant_pools_never_see_each_others_rows` above).
    ///
    /// The "workers *are* configured and actually start" path is not covered
    /// here: `event_sessions`/`battle_sync` call the real AlbionBB/Albion Data
    /// APIs on their very first tick (`tokio::time::interval`'s first tick
    /// fires immediately, not after the interval), and none of those services
    /// accept a redirectable base URL — there is no way to exercise that path
    /// without a live network call inside the test.
    #[tokio::test]
    async fn provision_succeeds_without_workers_configured() {
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

        let id = unique_schema("tp");
        let schema = format!("tenant_{id}");
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenants (id, slug, name, schema_name, status, kind) \
                 VALUES ($1, $1, $1, $2, 'provisioning', 'guild')",
                [id.clone().into(), schema.clone().into()],
            ))
            .await
            .expect("insert provisioning tenant");
        let registry = TenantRegistry::new(url, control.clone());

        let ctx = registry
            .provision(&id, &schema)
            .await
            .expect("provision succeeds with no workers configured");
        assert_eq!(ctx.schema_name, schema);
        assert_eq!(registry.cached_len(), 1);

        drop_schema(&admin, &schema).await.expect("drop schema");
        cleanup_control_tenant(&control, &id, "")
            .await
            .expect("cleanup tenant");
    }

    /// `MODULE_KIND_ENFORCEMENT=enforce` refuses a guild-only module for an
    /// alliance tenant through the real middleware; `log` lets it through and
    /// counts it. Needs `TEST_DATABASE_URL`; skipped otherwise.
    #[tokio::test]
    async fn enforce_refuses_a_guild_only_module_for_an_alliance_only_in_enforce_mode() {
        use axum::body::Body;
        use axum::routing::get;
        use tower::ServiceExt;

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

        let id = unique_schema("te");
        let schema = format!("tenant_{id}");
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenants (id, slug, name, schema_name, status, kind) \
                 VALUES ($1, $1, $1, $2, 'active', 'alliance')",
                [id.clone().into(), schema.clone().into()],
            ))
            .await
            .expect("insert alliance tenant");
        ensure_schema(&admin, &schema).await.expect("tenant schema");
        // The legacy feature table must pass, so only the kind rule can refuse.
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenant_feature_flags (tenant_id, feature_key, enabled) \
                 VALUES ($1, 'warns', true)",
                [id.clone().into()],
            ))
            .await
            .expect("enable warns");

        let send = |mode: &str| {
            let mut cfg = cfg_with_bot_secret(Some("s3cret"));
            cfg.module_kind_enforcement = mode.to_owned();
            let registry = TenantRegistry::new(url.clone(), control.clone());
            let app = axum::Router::new()
                .route("/api/warns", get(|| async { "ok" }))
                .layer(axum::middleware::from_fn_with_state(
                    registry,
                    resolve_tenant,
                ))
                .layer(axum::Extension(ControlDb(control.clone())))
                .layer(axum::Extension(cfg));
            let request = axum::http::Request::builder()
                .uri("/api/warns")
                .header(BOT_SECRET_HEADER, "s3cret")
                .header(GUILD_ID_HEADER, id.as_str())
                .body(Body::empty())
                .expect("request");
            async move { app.oneshot(request).await.expect("router responds") }
        };

        let refused = send("enforce").await;
        assert_eq!(refused.status(), axum::http::StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(refused.into_body(), usize::MAX)
            .await
            .expect("body");
        let problem: serde_json::Value = serde_json::from_slice(&bytes).expect("problem json");
        assert_eq!(problem["code"], "module_unavailable");
        assert_eq!(problem["details"]["module"], "warns");

        let before = capabilities::gate::would_block_total();
        let allowed = send("log").await;
        assert_eq!(allowed.status(), axum::http::StatusCode::OK);
        assert!(capabilities::gate::would_block_total() > before);
        assert!(
            allowed
                .headers()
                .contains_key(capabilities::router::CAPABILITIES_VERSION_HEADER),
            "every tenant response carries the capabilities version"
        );

        drop_schema(&admin, &schema).await.expect("drop schema");
        cleanup_control_tenant(&control, &id, "")
            .await
            .expect("cleanup tenant");
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use sea_orm::Database;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    fn context(tenant_id: &str, db: DatabaseConnection) -> Arc<TenantContext> {
        Arc::new(TenantContext {
            tenant_id: tenant_id.to_owned(),
            schema_name: format!("tenant_{tenant_id}"),
            db,
            permissions: Permissions::new_empty(),
            features: HashSet::new(),
            kind: "guild".to_owned(),
        })
    }

    /// A control plane with one tenant `t1` in `status`, plus an empty flag table.
    async fn control_with_tenant(status: &str) -> DatabaseConnection {
        let control = Database::connect("sqlite::memory:")
            .await
            .expect("control sqlite");
        control
            .execute_unprepared(
                "CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL, \
                 kind TEXT NOT NULL)",
            )
            .await
            .expect("tenants table");
        control
            .execute_unprepared(
                "CREATE TABLE tenant_feature_flags (tenant_id TEXT NOT NULL, \
                 feature_key TEXT NOT NULL, enabled BOOLEAN NOT NULL)",
            )
            .await
            .expect("flags table");
        control
            .execute_unprepared(&format!(
                "INSERT INTO tenants (id, status, kind) VALUES ('t1', '{status}', 'guild')"
            ))
            .await
            .expect("tenant row");
        control
    }

    async fn pool() -> DatabaseConnection {
        Database::connect("sqlite::memory:")
            .await
            .expect("tenant sqlite")
    }

    /// A tenant database with the real schema, for code that reads the permission
    /// tables.
    async fn migrated_pool() -> DatabaseConnection {
        crate::testkit::migrated_sqlite().await
    }

    #[tokio::test]
    async fn refresh_reloads_flags_and_keeps_the_pool() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control.clone());
        let before = context("t1", migrated_pool().await);
        registry.inner.insert("t1".to_owned(), Arc::clone(&before));
        control
            .execute_unprepared(
                "INSERT INTO tenant_feature_flags (tenant_id, feature_key, enabled) \
                 VALUES ('t1', 'bank', 1)",
            )
            .await
            .expect("flag");

        registry.refresh("t1").await;

        let after = registry.inner.get("t1").expect("still cached").clone();
        assert!(
            !Arc::ptr_eq(&before, &after),
            "a fresh context replaces the old one"
        );
        assert!(after.features.contains("bank"));
        assert!(
            before.features.is_empty(),
            "the old snapshot is left untouched"
        );
        assert_eq!(after.schema_name, before.schema_name);
        after.db.ping().await.expect("the shared pool still works");
    }

    #[tokio::test]
    async fn refresh_evicts_a_tenant_that_is_no_longer_active() {
        let control = control_with_tenant("suspended").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        registry
            .inner
            .insert("t1".to_owned(), context("t1", pool().await));

        registry.refresh("t1").await;

        assert_eq!(registry.cached_len(), 0);
    }

    #[tokio::test]
    async fn refresh_of_an_uncached_tenant_is_a_no_op() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);

        registry.refresh("t1").await;

        assert_eq!(registry.cached_len(), 0);
    }

    #[tokio::test]
    async fn concurrent_first_loads_run_the_loader_once() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        let db = pool().await;
        let calls = Arc::new(AtomicUsize::new(0));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let registry = registry.clone();
            let calls = Arc::clone(&calls);
            let db = db.clone();
            tasks.push(tokio::spawn(async move {
                registry
                    .load_once("t1", || {
                        let calls = Arc::clone(&calls);
                        let db = db.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            // Hold the gate long enough for the other callers to queue on it.
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            Ok(context("t1", db))
                        }
                    })
                    .await
            }));
        }
        for task in tasks {
            task.await.expect("join").expect("load");
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "one pool and one migration check"
        );
        assert_eq!(registry.cached_len(), 1);
    }

    #[tokio::test]
    async fn a_load_that_overlaps_an_eviction_is_not_cached() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        let db = pool().await;
        let suspending = registry.clone();

        let ctx = registry
            .load_once("t1", || async move {
                // Suspension commits, then evicts, while this load is still reading.
                suspending.evict("t1");
                Ok(context("t1", db))
            })
            .await
            .expect("load");

        assert_eq!(ctx.tenant_id, "t1", "the caller still gets its context");
        assert_eq!(
            registry.cached_len(),
            0,
            "a load that overlapped a suspension must not be cached"
        );
    }

    #[tokio::test]
    async fn a_load_that_overlaps_a_refresh_is_not_cached() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        let db = pool().await;
        let writer = registry.clone();

        registry
            .load_once("t1", || async move {
                // A flag write refreshes while the cold load is still reading.
                writer.refresh("t1").await;
                Ok(context("t1", db))
            })
            .await
            .expect("load");

        assert_eq!(
            registry.cached_len(),
            0,
            "flags read before a write must not be cached"
        );
    }

    #[tokio::test]
    async fn a_refresh_whose_reload_overlaps_an_eviction_does_not_recache() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        registry
            .inner
            .insert("t1".to_owned(), context("t1", pool().await));

        // The refresh read the tenant as active, then suspension evicted before it inserted.
        let epoch = registry.epoch("t1");
        registry.evict("t1");
        registry.publish("t1", epoch, &context("t1", pool().await));

        assert_eq!(registry.cached_len(), 0);
    }

    #[tokio::test]
    async fn a_refresh_with_no_overlapping_invalidation_is_cached() {
        let control = control_with_tenant("active").await;
        let registry = TenantRegistry::new("sqlite::memory:".into(), control);
        registry
            .inner
            .insert("t1".to_owned(), context("t1", migrated_pool().await));

        registry.refresh("t1").await;

        assert_eq!(registry.cached_len(), 1);
    }
}
