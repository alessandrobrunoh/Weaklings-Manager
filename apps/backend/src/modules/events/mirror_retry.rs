//! Durable retry for guild-origin events that must be mirrored to the alliance.
//!
//! The source event commits in the guild tenant before the cross-tenant mirror
//! is attempted. If the mirror fails, the request is recorded here and retried
//! with backoff. `create_mirror` is idempotent through `event_sync_links`, so a
//! retry after a partial success converges on the same mirror.

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, Statement};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    errors::AppError,
    modules::{
        alliance_share::ShareActor,
        events::{entities::event, service::EventService, sync::create_mirror},
    },
    tenant::TenantRegistry,
};

const LEASE_SECONDS: i64 = 60;
const MAX_ATTEMPTS: i32 = 12;
const MAX_REQUESTS_PER_TICK: i64 = 8;

/// Operator-visible state of a guild event's alliance mirror request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct MirrorRequestStatus {
    /// `pending`, `processing`, `complete`, `failed`, or `inactive`.
    pub state: String,
    /// Number of mirror attempts so far.
    pub attempts: i32,
    /// Latest failure detail.
    pub last_error: Option<String>,
    /// Created alliance event id, once the mirror exists.
    pub mirror_event_id: Option<i64>,
    /// Earliest next automatic retry.
    pub next_attempt_at: DateTime<Utc>,
    /// `true` once automatic retries are exhausted and an operator must intervene.
    pub exhausted: bool,
}

struct Claimed {
    id: Uuid,
    source_tenant_id: String,
    source_event_id: i64,
    actor: ShareActor,
    attempts: i32,
    lease_token: Uuid,
}

/// Records (or re-arms) a mirror request after an inline attempt failed.
pub async fn enqueue(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
    actor: &ShareActor,
    error: &str,
) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO event_mirror_requests \
             (id, source_tenant_id, source_event_id, actor_discord_id, actor_username, actor_email, \
              state, last_error, next_attempt_at) \
             VALUES ($1,$2,$3,$4,$5,$6,'pending',$7, NOW() + INTERVAL '15 seconds') \
             ON CONFLICT (source_tenant_id, source_event_id) DO UPDATE SET \
               state='pending', last_error=EXCLUDED.last_error, attempts=0, \
               actor_discord_id=EXCLUDED.actor_discord_id, actor_username=EXCLUDED.actor_username, \
               actor_email=EXCLUDED.actor_email, \
               next_attempt_at=NOW() + INTERVAL '15 seconds', lease_until=NULL, updated_at=NOW() \
             WHERE event_mirror_requests.state <> 'complete'",
            [
                Uuid::new_v4().into(),
                source_tenant_id.into(),
                source_event_id.into(),
                actor.discord_id.clone().into(),
                actor.username.clone().into(),
                actor.email.clone().into(),
                error.to_owned().into(),
            ],
        ))
        .await?;
    Ok(())
}

/// Returns the mirror request state for a guild event, if one was ever queued.
pub async fn status_for_event(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
) -> Result<Option<MirrorRequestStatus>, AppError> {
    let Some(row) = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT state, attempts, last_error, mirror_event_id, next_attempt_at \
             FROM event_mirror_requests WHERE source_tenant_id=$1 AND source_event_id=$2",
            [source_tenant_id.into(), source_event_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let state: String = row.try_get_by_index(0)?;
    let attempts: i32 = row.try_get_by_index(1)?;
    Ok(Some(MirrorRequestStatus {
        exhausted: state == "failed" && attempts >= MAX_ATTEMPTS,
        state,
        attempts,
        last_error: row.try_get_by_index(2)?,
        mirror_event_id: row.try_get_by_index(3)?,
        next_attempt_at: row.try_get_by_index(4)?,
    }))
}

/// Re-arms an exhausted, failed, or inactive request after an operator fixes its cause.
pub async fn requeue(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
) -> Result<(), AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE event_mirror_requests SET state='pending', attempts=0, last_error=NULL, \
               next_attempt_at=NOW(), lease_until=NULL, lease_token=NULL, updated_at=NOW() \
             WHERE source_tenant_id=$1 AND source_event_id=$2 AND state IN ('failed','inactive')",
            [source_tenant_id.into(), source_event_id.into()],
        ))
        .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "mirror request is not failed/inactive or does not exist".to_owned(),
        ));
    }
    Ok(())
}

async fn claim_due(control: &DatabaseConnection) -> Result<Vec<Claimed>, AppError> {
    let lease_token = Uuid::new_v4();
    let rows = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "WITH picked AS ( \
               SELECT id FROM event_mirror_requests \
               WHERE state IN ('pending','failed','processing') \
                 AND attempts < $1 AND next_attempt_at <= NOW() \
                 AND (lease_until IS NULL OR lease_until <= NOW()) \
               ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED \
             ) UPDATE event_mirror_requests r SET state='processing', attempts=r.attempts+1, \
               lease_until=NOW() + ($3 * INTERVAL '1 second'), lease_token=$4, updated_at=NOW() \
             FROM picked p WHERE r.id=p.id \
             RETURNING r.id, r.source_tenant_id, r.source_event_id, r.actor_discord_id, \
                       r.actor_username, r.actor_email, r.attempts",
            [
                MAX_ATTEMPTS.into(),
                MAX_REQUESTS_PER_TICK.into(),
                LEASE_SECONDS.into(),
                lease_token.into(),
            ],
        ))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            Ok(Claimed {
                id: row.try_get_by_index(0)?,
                source_tenant_id: row.try_get_by_index(1)?,
                source_event_id: row.try_get_by_index(2)?,
                actor: ShareActor {
                    discord_id: row.try_get_by_index(3)?,
                    username: row.try_get_by_index(4)?,
                    email: row.try_get_by_index(5)?,
                },
                attempts: row.try_get_by_index(6)?,
                lease_token,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()?)
}

/// Processes due mirror requests once. Called from the periodic fanout worker.
pub async fn process_due(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
) -> Result<usize, AppError> {
    let claimed = claim_due(control).await?;
    let count = claimed.len();
    for request in claimed {
        match attempt(control, registry, &request).await {
            Ok(Some(mirror_event_id)) => {
                finish(
                    control,
                    &request,
                    "complete",
                    None,
                    Some(mirror_event_id),
                    0,
                )
                .await?;
            }
            Ok(None) => {
                finish(control, &request, "inactive", None, None, 0).await?;
            }
            Err(error) => {
                let message = error.to_string();
                tracing::warn!(
                    source_tenant_id = %request.source_tenant_id,
                    source_event_id = request.source_event_id,
                    attempt = request.attempts,
                    error = %message,
                    "alliance event mirror failed; scheduled for retry"
                );
                let delay = retry_delay_seconds(request.attempts);
                finish(control, &request, "failed", Some(&message), None, delay).await?;
            }
        }
    }
    Ok(count)
}

fn retry_delay_seconds(attempt: i32) -> i64 {
    15_i64
        .saturating_mul(1_i64 << attempt.clamp(0, 8))
        .min(3600)
}

async fn attempt(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    request: &Claimed,
) -> Result<Option<i64>, AppError> {
    let source = registry.get_or_load(&request.source_tenant_id).await?;
    let model = event::Entity::find_by_id(request.source_event_id)
        .one(&source.db)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "source event {} no longer exists",
                request.source_event_id
            ))
        })?;
    if model.archived_at.is_some() || model.status == "cancelled" {
        return Ok(None);
    }
    let view = EventService::new().to_event_view(&source.db, model).await?;
    create_mirror(
        control,
        registry,
        &source.db,
        &request.source_tenant_id,
        &view,
        &request.actor,
    )
    .await
}

/// Fenced by the lease token so a worker whose lease expired cannot overwrite
/// the result of the worker that reclaimed the request.
async fn finish(
    control: &DatabaseConnection,
    request: &Claimed,
    state: &str,
    error: Option<&str>,
    mirror_event_id: Option<i64>,
    retry_delay: i64,
) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE event_mirror_requests SET state=$3, last_error=$4, \
               mirror_event_id=COALESCE($5, mirror_event_id), \
               next_attempt_at=NOW() + ($6 * INTERVAL '1 second'), \
               lease_until=NULL, updated_at=NOW() \
             WHERE id=$1 AND lease_token=$2 AND state='processing'",
            [
                request.id.into(),
                request.lease_token.into(),
                state.into(),
                error.map(str::to_owned).into(),
                mirror_event_id.into(),
                retry_delay.into(),
            ],
        ))
        .await?;
    Ok(())
}
