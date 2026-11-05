//! Durable control-plane coordinator for alliance event fanout.
//!
//! This module owns job/target state only. Event creation belongs to the caller
//! (the target claim carries the source and destination tenant ids).

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::errors::AppError;

/// Supported source-event operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Publish a new event to active alliance members.
    Publish,
    /// Update existing mirrors.
    Update,
    /// Archive existing mirrors.
    Archive,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Publish => "publish",
            Self::Update => "update",
            Self::Archive => "archive",
        }
    }
}

/// One target leased to a worker for processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedTarget {
    /// Owning fanout job.
    pub job_id: Uuid,
    /// Source control-plane tenant.
    pub source_tenant_id: String,
    /// Source event primary key.
    pub source_event_id: i64,
    /// Job operation stored in the control plane.
    pub operation: String,
    /// Tenant selected from the active membership snapshot.
    pub tenant_id: String,
    /// Attempt number after this claim.
    pub attempts: i32,
    /// Fences off a worker whose lease expired while it was still processing.
    pub lease_token: Uuid,
}

/// Target state exposed to event owners and administrators.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct TargetStatus {
    /// Destination tenant id.
    pub tenant_id: String,
    /// `pending`, `processing`, `complete`, `failed`, or `inactive`.
    pub state: String,
    /// Created destination event id, when available.
    pub destination_event_id: Option<i64>,
    /// Number of attempts.
    pub attempts: i32,
    /// Latest failure detail.
    pub last_error: Option<String>,
    /// Earliest next retry time.
    pub next_attempt_at: DateTime<Utc>,
}

/// Latest publish-job state and per-guild results for a canonical event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct EventFanoutStatus {
    /// Control-plane job id.
    pub job_id: String,
    /// `pending`, `processing`, `complete`, or `failed`.
    pub state: String,
    /// Per-target delivery state.
    pub targets: Vec<TargetStatus>,
}

/// Enqueues one idempotent job and its target snapshot, returning the stable job id.
///
/// Repeated calls with the same source, operation, and key do not change the
/// existing membership snapshot.
pub async fn enqueue(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
    operation: Operation,
    idempotency_key: &str,
    active_target_tenant_ids: &[String],
) -> Result<Uuid, AppError> {
    if idempotency_key.trim().is_empty() {
        return Err(AppError::Validation(
            "event fanout idempotency key cannot be empty".to_owned(),
        ));
    }
    let txn = control.begin().await?;
    let proposed_id = Uuid::new_v4();
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO event_fanout_jobs \
         (id, source_tenant_id, source_event_id, operation, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (source_tenant_id, source_event_id, operation, idempotency_key) \
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id",
            [
                proposed_id.into(),
                source_tenant_id.to_owned().into(),
                source_event_id.into(),
                operation.as_str().into(),
                idempotency_key.to_owned().into(),
            ],
        ))
        .await?
        .expect("INSERT ... RETURNING always returns a row");
    let job_id: Uuid = row.try_get_by_index(0)?;
    if job_id == proposed_id {
        for target in active_target_tenant_ids
            .iter()
            .filter(|id| id.as_str() != source_tenant_id)
        {
            txn.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO event_fanout_targets (job_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [job_id.into(), target.to_owned().into()],
            )).await?;
        }
    }
    refresh_job_state(&txn, job_id).await?;
    txn.commit().await?;
    Ok(job_id)
}

/// Claims up to `limit` due targets under row locks, reclaiming expired leases.
pub async fn claim_due(
    control: &DatabaseConnection,
    limit: u64,
    lease_seconds: i64,
) -> Result<Vec<ClaimedTarget>, AppError> {
    if limit == 0 || lease_seconds <= 0 {
        return Err(AppError::Validation(
            "event fanout claim limit and lease must be positive".to_owned(),
        ));
    }
    let txn = control.begin().await?;
    let lease_token = Uuid::new_v4();
    let rows = txn.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "WITH picked AS ( \
           SELECT t.job_id, t.tenant_id FROM event_fanout_targets t \
           JOIN event_fanout_jobs j ON j.id = t.job_id \
           WHERE t.state IN ('pending','failed','processing') \
             AND t.next_attempt_at <= NOW() \
             AND (t.lease_until IS NULL OR t.lease_until <= NOW()) \
           ORDER BY t.next_attempt_at, t.tenant_id LIMIT $1 \
           FOR UPDATE OF t SKIP LOCKED \
         ), claimed AS ( \
           UPDATE event_fanout_targets t SET state='processing', attempts=t.attempts+1, \
             lease_until=NOW() + ($2 * INTERVAL '1 second'), lease_token=$3, updated_at=NOW() \
           FROM picked p WHERE t.job_id=p.job_id AND t.tenant_id=p.tenant_id \
           RETURNING t.job_id, t.tenant_id, t.attempts, t.lease_token \
         ) SELECT c.job_id, j.source_tenant_id, j.source_event_id, c.tenant_id, c.attempts, c.lease_token, j.operation \
           FROM claimed c JOIN event_fanout_jobs j ON j.id=c.job_id",
        [
            i64::try_from(limit).unwrap_or(i64::MAX).into(),
            lease_seconds.into(),
            lease_token.into(),
        ],
    )).await?;
    let claimed = rows
        .into_iter()
        .map(|row| {
            Ok(ClaimedTarget {
                job_id: row.try_get_by_index(0)?,
                source_tenant_id: row.try_get_by_index(1)?,
                source_event_id: row.try_get_by_index(2)?,
                tenant_id: row.try_get_by_index(3)?,
                attempts: row.try_get_by_index(4)?,
                lease_token: row.try_get_by_index(5)?,
                operation: row.try_get_by_index(6)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()?;
    for target in &claimed {
        refresh_job_state(&txn, target.job_id).await?;
    }
    txn.commit().await?;
    Ok(claimed)
}

/// Records successful processing and the copied event id.
pub async fn mark_succeeded(
    control: &DatabaseConnection,
    job_id: Uuid,
    tenant_id: &str,
    lease_token: Uuid,
    destination_event_id: i64,
) -> Result<(), AppError> {
    finish_target(
        control,
        job_id,
        tenant_id,
        lease_token,
        "complete",
        None,
        Some(destination_event_id),
        0,
    )
    .await
}

/// Records a retryable failure, with delay in seconds before the next claim.
pub async fn mark_retryable(
    control: &DatabaseConnection,
    job_id: Uuid,
    tenant_id: &str,
    lease_token: Uuid,
    error: &str,
    delay_seconds: i64,
) -> Result<(), AppError> {
    finish_target(
        control,
        job_id,
        tenant_id,
        lease_token,
        "failed",
        Some(error),
        None,
        delay_seconds.max(1),
    )
    .await
}

/// Marks a target inactive when its membership is no longer active.
pub async fn mark_inactive(
    control: &DatabaseConnection,
    job_id: Uuid,
    tenant_id: &str,
    lease_token: Uuid,
) -> Result<(), AppError> {
    finish_target(
        control,
        job_id,
        tenant_id,
        lease_token,
        "inactive",
        None,
        None,
        0,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn finish_target(
    control: &DatabaseConnection,
    job_id: Uuid,
    tenant_id: &str,
    lease_token: Uuid,
    state: &str,
    error: Option<&str>,
    destination: Option<i64>,
    delay: i64,
) -> Result<(), AppError> {
    let txn = control.begin().await?;
    let update = txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE event_fanout_targets SET state=$4, last_error=$5, destination_event_id=COALESCE($6,destination_event_id), \
         lease_until=NULL, lease_token=NULL, next_attempt_at=NOW()+($7 * INTERVAL '1 second'), updated_at=NOW() \
         WHERE job_id=$1 AND tenant_id=$2 AND state='processing' AND lease_token=$3",
        [
            job_id.into(),
            tenant_id.to_owned().into(),
            lease_token.into(),
            state.into(),
            error.map(str::to_owned).into(),
            destination.into(),
            delay.into(),
        ],
    )).await?;
    if update.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "event fanout target lease expired or was replaced".to_owned(),
        ));
    }
    refresh_job_state(&txn, job_id).await?;
    txn.commit().await?;
    Ok(())
}

async fn refresh_job_state(db: &impl ConnectionTrait, job_id: Uuid) -> Result<(), sea_orm::DbErr> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE event_fanout_jobs j SET state = CASE \
         WHEN NOT EXISTS (SELECT 1 FROM event_fanout_targets t WHERE t.job_id=j.id AND t.state NOT IN ('complete','inactive')) THEN 'complete' \
         WHEN EXISTS (SELECT 1 FROM event_fanout_targets t WHERE t.job_id=j.id AND t.state='failed') THEN 'failed' \
         WHEN EXISTS (SELECT 1 FROM event_fanout_targets t WHERE t.job_id=j.id AND t.state='processing') THEN 'processing' \
         ELSE 'pending' END, updated_at=NOW() WHERE j.id=$1",
        [job_id.into()],
    )).await?;
    Ok(())
}

/// Returns per-target state for the owner/admin authorization layer to expose.
pub async fn target_statuses(
    control: &DatabaseConnection,
    job_id: Uuid,
) -> Result<Vec<TargetStatus>, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT tenant_id,state,destination_event_id,attempts,last_error,next_attempt_at \
         FROM event_fanout_targets WHERE job_id=$1 ORDER BY tenant_id",
            [job_id.into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(TargetStatus {
                tenant_id: row.try_get_by_index(0)?,
                state: row.try_get_by_index(1)?,
                destination_event_id: row.try_get_by_index(2)?,
                attempts: row.try_get_by_index(3)?,
                last_error: row.try_get_by_index(4)?,
                next_attempt_at: row.try_get_by_index(5)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(Into::into)
}

/// Latest publish status for an event in its owner tenant.
pub async fn status_for_event(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
) -> Result<Option<EventFanoutStatus>, AppError> {
    let Some(row) = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, state FROM event_fanout_jobs \
             WHERE source_tenant_id=$1 AND source_event_id=$2 AND operation='publish' \
             ORDER BY created_at DESC LIMIT 1",
            [source_tenant_id.into(), source_event_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let job_id: Uuid = row.try_get_by_index(0)?;
    let state: String = row.try_get_by_index(1)?;
    Ok(Some(EventFanoutStatus {
        job_id: job_id.to_string(),
        state,
        targets: target_statuses(control, job_id).await?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm::{ConnectionTrait, DatabaseConnection};
    use sea_orm_migration::MigratorTrait;

    struct TestDatabase {
        admin: DatabaseConnection,
        db: DatabaseConnection,
        schema: String,
    }

    impl TestDatabase {
        async fn new() -> Option<Self> {
            let (url, admin) = try_admin_db().await?;
            let schema = unique_schema("fanout");
            ensure_schema(&admin, &schema)
                .await
                .expect("create test schema");
            let db = connect_with_search_path(&url, &schema)
                .await
                .expect("connect test schema");
            crate::control_migration::Migrator::up(&db, None)
                .await
                .expect("apply control migrations");
            let test_db = Self { admin, db, schema };
            test_db.insert_tenant("alliance").await;
            test_db.insert_tenant("guild-a").await;
            test_db.insert_tenant("guild-b").await;
            Some(test_db)
        }

        async fn insert_tenant(&self, tenant_id: &str) {
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO tenants (id, slug, name, schema_name, status) \
                     VALUES ($1, $1, $1, $1, 'active')",
                    [tenant_id.into()],
                ))
                .await
                .expect("insert test tenant");
        }

        async fn close(self) {
            self.db.close().await.expect("close test db");
            drop_schema(&self.admin, &self.schema)
                .await
                .expect("drop test schema");
        }
    }

    #[tokio::test]
    async fn enqueue_is_idempotent_and_snapshots_targets_once() {
        let Some(test_db) = TestDatabase::new().await else {
            return;
        };
        let targets = vec!["guild-a".to_owned(), "guild-b".to_owned()];
        let job = enqueue(
            &test_db.db,
            "alliance",
            12,
            Operation::Publish,
            "publish:v1",
            &targets,
        )
        .await
        .expect("enqueue");
        let same_job = enqueue(
            &test_db.db,
            "alliance",
            12,
            Operation::Publish,
            "publish:v1",
            &["alliance".to_owned()],
        )
        .await
        .expect("idempotent enqueue");
        assert_eq!(job, same_job);
        assert_eq!(target_statuses(&test_db.db, job).await.unwrap().len(), 2);
        let event_status = status_for_event(&test_db.db, "alliance", 12)
            .await
            .unwrap()
            .expect("status for source event");
        assert_eq!(event_status.job_id, job.to_string());
        assert_eq!(event_status.targets.len(), 2);

        let no_targets = enqueue(
            &test_db.db,
            "alliance",
            13,
            Operation::Publish,
            "publish:v1",
            &[],
        )
        .await
        .expect("enqueue without targets");
        let state: String = test_db
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT state FROM event_fanout_jobs WHERE id = $1",
                [no_targets.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get_by_index(0)
            .unwrap();
        assert_eq!(state, "complete");
        test_db.close().await;
    }

    #[tokio::test]
    async fn retry_reclaim_fences_the_expired_worker() {
        let Some(test_db) = TestDatabase::new().await else {
            return;
        };
        let job = enqueue(
            &test_db.db,
            "alliance",
            22,
            Operation::Publish,
            "publish:v1",
            &["guild-a".to_owned()],
        )
        .await
        .expect("enqueue");
        let first = claim_due(&test_db.db, 1, 1)
            .await
            .expect("first claim")
            .pop()
            .expect("one claimed target");
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let second = claim_due(&test_db.db, 1, 30)
            .await
            .expect("reclaim expired lease")
            .pop()
            .expect("reclaimed target");
        assert_ne!(first.lease_token, second.lease_token);
        assert_eq!(second.attempts, 2);

        let stale = mark_succeeded(&test_db.db, job, "guild-a", first.lease_token, 99).await;
        assert!(matches!(stale, Err(AppError::Conflict(_))));
        mark_succeeded(&test_db.db, job, "guild-a", second.lease_token, 101)
            .await
            .expect("current lease can complete");
        let statuses = target_statuses(&test_db.db, job).await.unwrap();
        assert_eq!(statuses[0].state, "complete");
        assert_eq!(statuses[0].destination_event_id, Some(101));
        test_db.close().await;
    }
}
