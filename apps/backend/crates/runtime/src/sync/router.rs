//! Status and retry routes of the sync engine, mounted under `/api/sync`.
//!
//! Reads need `sync.view`; retries and resyncs need `sync.manage`. Rows are
//! restricted to the caller tenant (origin or target). Entity-scoped routes
//! also accepting the entity's own manage authority arrive with the owning
//! slices.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};
use chrono::Utc;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::jobs::{self, JobFilter, JobRecord};
use super::outbox::{self, SyncEmit, SyncOp};
use super::policy::SyncSettings;
use crate::{Runtime, WakeSet, WakeTarget};
use backend_core::errors::AppError;
use backend_core::responses::ApiResponse;
use backend_identity::auth::{Permission, Permissions, UserContext};
use backend_identity::tenant::{ControlDb, CurrentTenantId};

/// Largest page of the attention list.
const MAX_PAGE: u64 = 200;

/// Router for `/api/sync`.
pub fn router() -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/summary", get(summary))
        .route("/jobs", get(list_jobs))
        .route("/jobs/{id}/retry", post(retry_job))
        .route("/retry", post(retry_entity))
        .route("/resync", post(resync_entity))
}

/// Per-entity status: the state of every target and the aggregate.
#[derive(Debug, Clone, Serialize)]
pub struct EntityStatusView {
    /// Entity this status is about.
    pub entity: EntityRefView,
    /// `not_synced`, `ok`, `pending`, `blocked` or `failed` (any exhausted target).
    pub state: String,
    /// One job per target.
    pub targets: Vec<JobRecord>,
}

/// Entity reference in responses.
#[derive(Debug, Clone, Serialize)]
pub struct EntityRefView {
    /// Sync kind.
    pub kind: String,
    /// Id in the caller tenant.
    pub id: i64,
    /// Always `origin` for the status of owned entities.
    pub role: String,
}

/// Job counts for the caller tenant.
#[derive(Debug, Clone, Serialize)]
pub struct SummaryView {
    /// One row per kind and unfinished state.
    pub counts: Vec<CountView>,
}

/// One count row.
#[derive(Debug, Clone, Serialize)]
pub struct CountView {
    /// Sync kind.
    pub kind: String,
    /// Queue state.
    pub state: String,
    /// Jobs in that state.
    pub count: i64,
}

/// Query of the attention list.
#[derive(Debug, Clone, Deserialize)]
pub struct JobsQuery {
    /// Comma list of states (`retry,exhausted,blocked`).
    pub state: Option<String>,
    /// Exact kind.
    pub kind: Option<String>,
    /// `kind:id` of an owned entity.
    pub entity: Option<String>,
    /// Page size (default 50, max 200).
    pub limit: Option<u64>,
    /// Keyset cursor from the previous page (`next_cursor`).
    pub cursor: Option<i64>,
}

/// One page of the attention list.
#[derive(Debug, Clone, Serialize)]
pub struct JobsPageView {
    /// Jobs, newest first.
    pub jobs: Vec<JobRecord>,
    /// Pass as `cursor` to get the next page; absent on the last page.
    pub next_cursor: Option<i64>,
}

/// Query of the per-entity status.
#[derive(Debug, Clone, Deserialize)]
pub struct StatusQuery {
    /// `kind:id`, for example `event:123`.
    pub entity: String,
}

/// Body of entity-scoped retry and resync.
#[derive(Debug, Clone, Deserialize)]
pub struct EntityBody {
    /// `kind:id`.
    pub entity: String,
    /// Restrict to one target tenant.
    pub target_tenant_id: Option<String>,
}

/// Result of a retry.
#[derive(Debug, Clone, Serialize)]
pub struct RearmedView {
    /// Jobs re-armed.
    pub rearmed: u64,
}

/// Result of a resync: the outbox row the relay will pick up.
#[derive(Debug, Clone, Serialize)]
pub struct ResyncView {
    /// Outbox id (= the jobs' origin version).
    pub outbox_id: i64,
}

fn parse_entity(raw: &str) -> Result<(String, i64), AppError> {
    let (kind, id) = raw
        .split_once(':')
        .ok_or_else(|| AppError::Validation("entity must be kind:id".to_owned()))?;
    let id = id
        .parse::<i64>()
        .map_err(|_| AppError::Validation("entity id must be a number".to_owned()))?;
    if kind.is_empty() {
        return Err(AppError::Validation("entity kind is empty".to_owned()));
    }
    Ok((kind.to_owned(), id))
}

/// Aggregate of one entity's targets (`failed` beats `blocked` beats `pending`).
fn aggregate(jobs: &[JobRecord]) -> &'static str {
    if jobs.is_empty() {
        return "not_synced";
    }
    let any = |states: &[&str]| jobs.iter().any(|job| states.contains(&job.state.as_str()));
    if any(&["exhausted"]) {
        "failed"
    } else if any(&["blocked"]) {
        "blocked"
    } else if any(&["pending", "processing", "retry", "paused"]) {
        "pending"
    } else {
        "ok"
    }
}

/// Status of one entity owned by the caller.
pub(super) async fn status(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant)): Extension<CurrentTenantId>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<ApiResponse<EntityStatusView>>, AppError> {
    user.require(&perms, Permission::SyncView).await?;
    let (kind, id) = parse_entity(&query.entity)?;
    let targets = jobs::list(
        &control,
        &JobFilter {
            tenant_id: tenant,
            as_origin: true,
            kind: Some(kind.clone()),
            entity: Some((kind.clone(), id)),
            limit: MAX_PAGE,
            ..JobFilter::default()
        },
    )
    .await?;
    Ok(Json(ApiResponse::new(EntityStatusView {
        state: aggregate(&targets).to_owned(),
        entity: EntityRefView {
            kind,
            id,
            role: "origin".to_owned(),
        },
        targets,
    })))
}

/// Job counts for the caller tenant (nav badge, `/sync` in the bot).
pub(super) async fn summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant)): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<SummaryView>>, AppError> {
    user.require(&perms, Permission::SyncView).await?;
    let counts = jobs::summary(&control, &tenant)
        .await?
        .into_iter()
        .map(|(kind, state, count)| CountView { kind, state, count })
        .collect();
    Ok(Json(ApiResponse::new(SummaryView { counts })))
}

/// The attention list: unfinished jobs, optionally filtered.
pub(super) async fn list_jobs(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant)): Extension<CurrentTenantId>,
    Query(query): Query<JobsQuery>,
) -> Result<Json<ApiResponse<JobsPageView>>, AppError> {
    user.require(&perms, Permission::SyncView).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, MAX_PAGE);
    let states: Vec<String> = query
        .state
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|state| !state.is_empty())
        .map(str::to_owned)
        .collect();
    let entity = query.entity.as_deref().map(parse_entity).transpose()?;
    let page = jobs::list(
        &control,
        &JobFilter {
            tenant_id: tenant,
            as_origin: false,
            states,
            kind: query.kind,
            entity,
            before_seq: query.cursor,
            limit,
        },
    )
    .await?;
    let next_cursor = (page.len() as u64 == limit)
        .then(|| page.last().map(|job| job.seq))
        .flatten();
    Ok(Json(ApiResponse::new(JobsPageView {
        jobs: page,
        next_cursor,
    })))
}

/// Re-arms one job visible to the caller.
pub(super) async fn retry_job(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant)): Extension<CurrentTenantId>,
    Extension(runtime): Extension<Runtime>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiResponse<RearmedView>>, AppError> {
    user.require(&perms, Permission::SyncManage).await?;
    let rearmed = jobs::rearm(&control, id, &tenant, Utc::now()).await?;
    if !rearmed {
        return Err(AppError::NotFound(format!(
            "no retryable sync job {id} for this tenant"
        )));
    }
    runtime.kick(WakeSet::of(WakeTarget::SyncExecutor));
    Ok(Json(ApiResponse::new(RearmedView { rearmed: 1 })))
}

/// Re-arms every retryable job of one owned entity.
pub(super) async fn retry_entity(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant)): Extension<CurrentTenantId>,
    Extension(runtime): Extension<Runtime>,
    Json(body): Json<EntityBody>,
) -> Result<Json<ApiResponse<RearmedView>>, AppError> {
    user.require(&perms, Permission::SyncManage).await?;
    let (kind, id) = parse_entity(&body.entity)?;
    let rearmed = jobs::rearm_entity(
        &control,
        &tenant,
        &kind,
        id,
        body.target_tenant_id.as_deref(),
        Utc::now(),
    )
    .await?;
    runtime.kick(WakeSet::of(WakeTarget::SyncExecutor));
    Ok(Json(ApiResponse::new(RearmedView { rearmed })))
}

/// Enqueues a fresh upsert of an owned entity (repair after out-of-band
/// divergence). Refused for read-only copies and for kinds that are not enabled.
pub(super) async fn resync_entity(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(runtime): Extension<Runtime>,
    Json(body): Json<EntityBody>,
) -> Result<Json<ApiResponse<ResyncView>>, AppError> {
    user.require(&perms, Permission::SyncManage).await?;
    let (kind, id) = parse_entity(&body.entity)?;
    if !SyncSettings::from_env().is_active(&kind) {
        return Err(AppError::Conflict(format!(
            "sync kind {kind} is not enabled on this server"
        )));
    }
    let txn = db.begin().await?;
    let outbox_id = outbox::emit(&txn, SyncEmit::state(kind, id, SyncOp::Upsert))
        .await?
        .ok_or_else(|| {
            AppError::Conflict(
                "this entity is a read-only copy; resync it from its origin".to_owned(),
            )
        })?;
    txn.commit().await?;
    runtime.kick(WakeSet::of(WakeTarget::SyncRelay));
    Ok(Json(ApiResponse::new(ResyncView { outbox_id })))
}
