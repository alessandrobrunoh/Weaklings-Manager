//! The control-plane job queue: enqueue (coalescing, R25), claim (leases,
//! per-key ordering), fenced finish, operator re-arm, resume and purge.
//!
//! Every statement takes its clock from the caller (`now`), never from the
//! database, so the same SQL runs on Postgres (production) and on the SQLite
//! fixture used by the unit tests. Postgres adds `FOR UPDATE SKIP LOCKED` to
//! the claim.

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, QueryResult, Statement, Value};
use uuid::Uuid;

use crate::fence::LeaseFence;
use crate::state::{JobState, Step};
use backend_core::errors::AppError;

/// Seconds a claimed job may run before another worker may take it over.
pub const LEASE_SECONDS: i64 = 60;

/// A job to insert or coalesce.
#[derive(Debug, Clone, PartialEq)]
pub struct NewJob {
    /// Sync kind.
    pub kind: String,
    /// `upsert`, `delete`, `archive`, `command`.
    pub op: &'static str,
    /// `to_copy`, `to_origin` or `effect`.
    pub flow: &'static str,
    /// Tenant owning the entity.
    pub origin_tenant_id: String,
    /// Entity id in the origin tenant (0 for scans).
    pub origin_id: i64,
    /// Tenant that must receive the change.
    pub target_tenant_id: String,
    /// Extra coalescing dimension (discord id for member kinds, `''` otherwise).
    pub subject: String,
    /// Outbox id that produced the job.
    pub origin_version: i64,
    /// Jobs sharing a key run one at a time in `seq` order.
    pub ordering_key: String,
    /// Idempotency key of the relay insert (`{origin}:{outbox}:{target}:{kind}`).
    pub dedupe_key: String,
    /// Command body / cursor / effect arguments.
    pub payload: serde_json::Value,
    /// Claim priority (lower first).
    pub priority: i16,
    /// Automatic attempts before `exhausted`.
    pub max_attempts: i32,
}

impl NewJob {
    /// State jobs coalesce per (kind, origin entity, target, subject).
    fn is_state(&self) -> bool {
        matches!(self.op, "upsert" | "delete" | "archive")
    }
}

/// What [`enqueue`] did with a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueued {
    /// A new row was inserted.
    Inserted,
    /// A waiting job of the same key absorbed it (version bumped).
    Coalesced,
    /// The same dedupe key already exists: a replay, nothing changed.
    Duplicate,
}

/// Inserts `job` or folds it into a waiting job with the same coalescing key.
///
/// Order (R25): a state job first tries an `UPDATE` of a `pending`/`retry`
/// row; otherwise it inserts `ON CONFLICT (dedupe_key) DO NOTHING`. A unique
/// violation (a concurrent insert of the same key) repeats the sequence once.
///
/// # Errors
///
/// Database failures other than the single retried unique violation.
pub async fn enqueue(
    control: &DatabaseConnection,
    job: &NewJob,
    now: DateTime<Utc>,
) -> Result<Enqueued, AppError> {
    let mut violation = None;
    for _ in 0..2 {
        match enqueue_once(control, job, now).await {
            Ok(outcome) => return Ok(outcome),
            Err(error) if is_unique_violation(&error) => violation = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(violation.unwrap_or_else(|| AppError::Internal("enqueue failed".to_owned())))
}

async fn enqueue_once(
    control: &DatabaseConnection,
    job: &NewJob,
    now: DateTime<Utc>,
) -> Result<Enqueued, AppError> {
    if job.is_state() && coalesce(control, job, now).await? {
        return Ok(Enqueued::Coalesced);
    }
    if insert(control, job, now).await? {
        Ok(Enqueued::Inserted)
    } else {
        Ok(Enqueued::Duplicate)
    }
}

fn is_unique_violation(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("unique") || message.contains("duplicate key")
}

async fn coalesce(
    control: &DatabaseConnection,
    job: &NewJob,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    // A retry row is only pulled forward when it has been quiet for 30 s, so a
    // burst of emits cannot hammer a failing target. Pending rows always move up.
    let quiet_since = now - Duration::seconds(30);
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "UPDATE sync_jobs SET \
               origin_version = CASE WHEN origin_version < $1 THEN $1 ELSE origin_version END, \
               op = $2, \
               next_attempt_at = CASE \
                 WHEN state = 'pending' AND next_attempt_at > $3 THEN $3 \
                 WHEN state = 'retry' AND updated_at < $4 THEN $3 \
                 ELSE next_attempt_at END, \
               updated_at = $3 \
             WHERE kind = $5 AND origin_tenant_id = $6 AND origin_id = $7 \
               AND target_tenant_id = $8 AND subject = $9 \
               AND op IN ('upsert', 'delete', 'archive') AND state IN ('pending', 'retry')",
            [
                job.origin_version.into(),
                job.op.into(),
                now.into(),
                quiet_since.into(),
                job.kind.clone().into(),
                job.origin_tenant_id.clone().into(),
                job.origin_id.into(),
                job.target_tenant_id.clone().into(),
                job.subject.clone().into(),
            ],
        ))
        .await?;
    Ok(result.rows_affected() > 0)
}

async fn insert(
    control: &DatabaseConnection,
    job: &NewJob,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "INSERT INTO sync_jobs (id, kind, op, flow, origin_tenant_id, origin_id, \
               target_tenant_id, subject, origin_version, ordering_key, dedupe_key, payload, \
               priority, state, attempts, max_attempts, next_attempt_at, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', 0, $14, \
               $15, $15, $15) \
             ON CONFLICT (dedupe_key) DO NOTHING",
            [
                Uuid::new_v4().into(),
                job.kind.clone().into(),
                job.op.into(),
                job.flow.into(),
                job.origin_tenant_id.clone().into(),
                job.origin_id.into(),
                job.target_tenant_id.clone().into(),
                job.subject.clone().into(),
                job.origin_version.into(),
                job.ordering_key.clone().into(),
                job.dedupe_key.clone().into(),
                Value::Json(Some(Box::new(job.payload.clone()))),
                job.priority.into(),
                job.max_attempts.into(),
                now.into(),
            ],
        ))
        .await?;
    Ok(result.rows_affected() > 0)
}

/// A claimed job, with the fence its finish must present.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedJob {
    /// Job id.
    pub id: Uuid,
    /// Sync kind.
    pub kind: String,
    /// Operation.
    pub op: String,
    /// Flow.
    pub flow: String,
    /// Origin tenant.
    pub origin_tenant_id: String,
    /// Origin entity id.
    pub origin_id: i64,
    /// Target tenant.
    pub target_tenant_id: String,
    /// Coalescing subject.
    pub subject: String,
    /// Outbox id that produced the job.
    pub origin_version: i64,
    /// Ordering key.
    pub ordering_key: String,
    /// Payload.
    pub payload: serde_json::Value,
    /// Attempt number including this claim.
    pub attempts: i32,
    /// Cap for automatic attempts.
    pub max_attempts: i32,
    /// Fence of this claim.
    pub fence: LeaseFence,
}

/// Parameters of one claim round.
#[derive(Debug, Clone, Copy)]
pub struct ClaimRequest<'a> {
    /// Maximum jobs to claim.
    pub limit: u64,
    /// Current time (the lease starts here).
    pub now: DateTime<Utc>,
    /// Kinds that may run.
    pub kinds: &'a [String],
    /// Target tenants skipped this round (circuit breaker).
    pub excluded_targets: &'a [String],
}

/// Positional SQL parameters, numbered in the order they are pushed (SQLite
/// assigns `$n` indexes by first appearance, so first use must ascend).
#[derive(Default)]
pub(super) struct Params {
    pub(super) values: Vec<Value>,
}

impl Params {
    pub(super) fn push(&mut self, value: impl Into<Value>) -> String {
        self.values.push(value.into());
        format!("${}", self.values.len())
    }

    pub(super) fn list(&mut self, items: &[String]) -> String {
        items
            .iter()
            .map(|item| self.push(item.clone()))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Claims up to `limit` due jobs and leases them to the caller.
///
/// A job is due when it is `pending`/`retry`/`processing` with an expired or
/// absent lease and `next_attempt_at <= now`. Only the oldest live job of an
/// ordering key is eligible, so a key never runs two jobs at once.
///
/// # Errors
///
/// Database failures.
pub async fn claim_due(
    control: &DatabaseConnection,
    request: ClaimRequest<'_>,
) -> Result<Vec<ClaimedJob>, AppError> {
    if request.kinds.is_empty() {
        return Ok(Vec::new());
    }
    let backend = control.get_database_backend();
    // Values are pushed in the order their placeholders first appear in the SQL.
    let mut params = Params::default();
    let now = params.push(request.now);
    let kinds = params.list(request.kinds);
    let excluded = if request.excluded_targets.is_empty() {
        String::new()
    } else {
        format!(
            "AND j.target_tenant_id NOT IN ({}) ",
            params.list(request.excluded_targets)
        )
    };
    let limit = params.push(i64::try_from(request.limit).unwrap_or(i64::MAX));
    let until = params.push(request.now + Duration::seconds(LEASE_SECONDS));
    let token = params.push(Uuid::new_v4());
    let lock = if backend == DbBackend::Postgres {
        " FOR UPDATE SKIP LOCKED"
    } else {
        ""
    };
    let sql = format!(
        "WITH picked AS (
           SELECT j.seq FROM sync_jobs j
           WHERE j.state IN ('pending', 'retry', 'processing')
             AND j.next_attempt_at <= {now}
             AND (j.lease_until IS NULL OR j.lease_until <= {now})
             AND j.kind IN ({kinds})
             {excluded}
             AND NOT EXISTS (
               SELECT 1 FROM sync_jobs p
               WHERE p.ordering_key = j.ordering_key AND p.seq < j.seq
                 AND p.state IN ('pending', 'retry', 'processing'))
           ORDER BY j.priority, j.next_attempt_at, j.seq
           LIMIT {limit}{lock}
         )
         UPDATE sync_jobs SET state = 'processing', attempts = attempts + 1,
           lease_until = {until}, lease_token = {token}, updated_at = {now}
         WHERE seq IN (SELECT seq FROM picked)
         RETURNING id, kind, op, flow, origin_tenant_id, origin_id, target_tenant_id, subject,
           origin_version, ordering_key, payload, attempts, max_attempts, lease_token"
    );
    let rows = control
        .query_all(Statement::from_sql_and_values(backend, &sql, params.values))
        .await?;
    rows.iter()
        .map(|row| claimed(row, request.now + Duration::seconds(LEASE_SECONDS)))
        .collect()
}

fn claimed(row: &QueryResult, until: DateTime<Utc>) -> Result<ClaimedJob, AppError> {
    let token: Uuid = row.try_get_by_index(13)?;
    Ok(ClaimedJob {
        id: row.try_get_by_index(0)?,
        kind: row.try_get_by_index(1)?,
        op: row.try_get_by_index(2)?,
        flow: row.try_get_by_index(3)?,
        origin_tenant_id: row.try_get_by_index(4)?,
        origin_id: row.try_get_by_index(5)?,
        target_tenant_id: row.try_get_by_index(6)?,
        subject: row.try_get_by_index(7)?,
        origin_version: row.try_get_by_index(8)?,
        ordering_key: row.try_get_by_index(9)?,
        payload: row
            .try_get_by_index::<Option<serde_json::Value>>(10)?
            .unwrap_or(serde_json::Value::Null),
        attempts: row.try_get_by_index(11)?,
        max_attempts: row.try_get_by_index(12)?,
        fence: LeaseFence::with_token(token, until),
    })
}

/// The terminal update of one claimed job.
#[derive(Debug, Clone, PartialEq)]
pub struct Finish {
    /// State to write.
    pub state: JobState,
    /// Attempts to store (already refunded when the step asks for it).
    pub attempts: i32,
    /// When the job may run again.
    pub next_attempt_at: DateTime<Utc>,
    /// Set for terminal states.
    pub completed_at: Option<DateTime<Utc>>,
    /// `retryable`, `permanent`, `blocked`.
    pub error_class: Option<&'static str>,
    /// Failure text.
    pub last_error: Option<String>,
}

impl Finish {
    /// Builds the finish of a job that ended in `step`.
    #[must_use]
    pub fn new(step: Step, attempts: i32, now: DateTime<Utc>, delay: Duration) -> Self {
        let attempts = if step.refund_attempt {
            attempts - 1
        } else {
            attempts
        };
        Self {
            state: step.state,
            attempts,
            next_attempt_at: if step.schedule_retry {
                now + delay
            } else {
                now
            },
            completed_at: step.state.is_terminal().then_some(now),
            error_class: None,
            last_error: None,
        }
    }
}

/// Writes the terminal update, fenced by `token`.
///
/// # Errors
///
/// `Conflict` when the lease was taken over (the caller discards its result),
/// database failures otherwise.
pub async fn finish(
    control: &DatabaseConnection,
    job_id: Uuid,
    token: Uuid,
    finish: &Finish,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "UPDATE sync_jobs SET state = $1, attempts = $2, next_attempt_at = $3, \
               completed_at = $4, error_class = $5, last_error = $6, \
               lease_until = NULL, lease_token = NULL, updated_at = $7 \
             WHERE id = $8 AND lease_token = $9 AND state = 'processing'",
            [
                finish.state.as_str().into(),
                finish.attempts.into(),
                finish.next_attempt_at.into(),
                finish.completed_at.into(),
                finish.error_class.map(str::to_owned).into(),
                finish.last_error.clone().into(),
                now.into(),
                job_id.into(),
                token.into(),
            ],
        ))
        .await?;
    LeaseFence::ensure_held(result.rows_affected(), "sync job")
}

/// Operator retry of one job visible to `tenant_id`:
/// `retry|exhausted|blocked` -> `pending` with attempts reset.
///
/// # Errors
///
/// Database failures.
pub async fn rearm(
    control: &DatabaseConnection,
    job_id: Uuid,
    tenant_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "UPDATE sync_jobs SET state = 'pending', attempts = 0, next_attempt_at = $1, \
               updated_at = $1 \
             WHERE id = $2 AND state IN ('retry', 'exhausted', 'blocked') \
               AND (origin_tenant_id = $3 OR target_tenant_id = $3)",
            [now.into(), job_id.into(), tenant_id.into()],
        ))
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Re-arms every retry-able job of one origin entity (optionally for one target).
///
/// # Errors
///
/// Database failures.
pub async fn rearm_entity(
    control: &DatabaseConnection,
    origin_tenant_id: &str,
    kind: &str,
    origin_id: i64,
    target: Option<&str>,
    now: DateTime<Utc>,
) -> Result<u64, AppError> {
    let mut params = Params::default();
    let now_ph = params.push(now);
    let origin = params.push(origin_tenant_id.to_owned());
    let kind_ph = params.push(kind.to_owned());
    let id_ph = params.push(origin_id);
    let target_clause = match target {
        Some(target) => format!("AND target_tenant_id = {}", params.push(target.to_owned())),
        None => String::new(),
    };
    let sql = format!(
        "UPDATE sync_jobs SET state = 'pending', attempts = 0, next_attempt_at = {now_ph}, \
           updated_at = {now_ph} \
         WHERE origin_tenant_id = {origin} AND kind = {kind_ph} AND origin_id = {id_ph} \
           AND state IN ('retry', 'exhausted', 'blocked') {target_clause}"
    );
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            &sql,
            params.values,
        ))
        .await?;
    Ok(result.rows_affected())
}

/// Moves the paused jobs of a resumed tenant back to `pending`.
///
/// # Errors
///
/// Database failures.
pub async fn resume_tenant(
    control: &DatabaseConnection,
    tenant_id: &str,
    now: DateTime<Utc>,
) -> Result<u64, AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "UPDATE sync_jobs SET state = 'pending', next_attempt_at = $1, updated_at = $1 \
             WHERE state = 'paused' AND (origin_tenant_id = $2 OR target_tenant_id = $2)",
            [now.into(), tenant_id.into()],
        ))
        .await?;
    Ok(result.rows_affected())
}

/// Deletes finished history: `done|superseded|inactive` after 30 days,
/// `cancelled` after 7 days.
///
/// # Errors
///
/// Database failures.
pub async fn purge(control: &DatabaseConnection, now: DateTime<Utc>) -> Result<u64, AppError> {
    let result = control
        .execute(Statement::from_sql_and_values(
            control.get_database_backend(),
            "DELETE FROM sync_jobs WHERE \
               (state IN ('done', 'superseded', 'inactive') AND completed_at < $1) \
               OR (state = 'cancelled' AND completed_at < $2)",
            [
                (now - Duration::days(30)).into(),
                (now - Duration::days(7)).into(),
            ],
        ))
        .await?;
    Ok(result.rows_affected())
}

/// One job as the status API shows it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct JobRecord {
    /// Job id.
    pub id: String,
    /// Global FIFO position (also the keyset cursor of the attention list).
    pub seq: i64,
    /// Sync kind.
    pub kind: String,
    /// Operation.
    pub op: String,
    /// Origin tenant.
    pub origin_tenant_id: String,
    /// Origin entity id.
    pub origin_id: i64,
    /// Target tenant.
    pub target_tenant_id: String,
    /// Queue state.
    pub state: String,
    /// Attempts consumed.
    pub attempts: i32,
    /// Automatic attempt cap.
    pub max_attempts: i32,
    /// `retryable`, `permanent` or `blocked`.
    pub error_class: Option<String>,
    /// Latest failure text.
    pub last_error: Option<String>,
    /// Earliest next attempt.
    pub next_attempt_at: DateTime<Utc>,
    /// Last change.
    pub updated_at: DateTime<Utc>,
}

/// Filters of [`list`].
#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    /// Caller tenant.
    pub tenant_id: String,
    /// Only jobs whose origin is the caller (status of owned entities).
    pub as_origin: bool,
    /// Accepted states; empty means all.
    pub states: Vec<String>,
    /// Exact kind.
    pub kind: Option<String>,
    /// Exact origin entity `(kind, id)`.
    pub entity: Option<(String, i64)>,
    /// Keyset cursor: only jobs with `seq` below this.
    pub before_seq: Option<i64>,
    /// Page size (already clamped by the caller).
    pub limit: u64,
}

/// Lists the jobs visible to a tenant, newest first.
///
/// # Errors
///
/// Database failures.
pub async fn list(
    control: &DatabaseConnection,
    filter: &JobFilter,
) -> Result<Vec<JobRecord>, AppError> {
    let mut params = Params::default();
    let tenant = params.push(filter.tenant_id.clone());
    let mut clauses = vec![if filter.as_origin {
        format!("origin_tenant_id = {tenant}")
    } else {
        format!("(origin_tenant_id = {tenant} OR target_tenant_id = {tenant})")
    }];
    if !filter.states.is_empty() {
        clauses.push(format!("state IN ({})", params.list(&filter.states)));
    }
    if let Some(kind) = &filter.kind {
        clauses.push(format!("kind = {}", params.push(kind.clone())));
    }
    if let Some((kind, id)) = &filter.entity {
        clauses.push(format!("kind = {}", params.push(kind.clone())));
        clauses.push(format!("origin_id = {}", params.push(*id)));
    }
    if let Some(cursor) = filter.before_seq {
        clauses.push(format!("seq < {}", params.push(cursor)));
    }
    let limit = params.push(i64::try_from(filter.limit).unwrap_or(i64::MAX));
    let sql = format!(
        "SELECT seq, id, kind, op, origin_tenant_id, origin_id, target_tenant_id, state, attempts, \
           max_attempts, error_class, last_error, next_attempt_at, updated_at \
         FROM sync_jobs WHERE {} ORDER BY seq DESC LIMIT {limit}",
        clauses.join(" AND ")
    );
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            &sql,
            params.values,
        ))
        .await?;
    rows.iter().map(read_record).collect()
}

fn read_record(row: &QueryResult) -> Result<JobRecord, AppError> {
    let id: Uuid = row.try_get_by_index(1)?;
    Ok(JobRecord {
        seq: row.try_get_by_index(0)?,
        id: id.to_string(),
        kind: row.try_get_by_index(2)?,
        op: row.try_get_by_index(3)?,
        origin_tenant_id: row.try_get_by_index(4)?,
        origin_id: row.try_get_by_index(5)?,
        target_tenant_id: row.try_get_by_index(6)?,
        state: row.try_get_by_index(7)?,
        attempts: row.try_get_by_index(8)?,
        max_attempts: row.try_get_by_index(9)?,
        error_class: row.try_get_by_index(10)?,
        last_error: row.try_get_by_index(11)?,
        next_attempt_at: row.try_get_by_index(12)?,
        updated_at: row.try_get_by_index(13)?,
    })
}

/// Job counts by kind and state for the jobs visible to `tenant_id`, excluding
/// finished ones.
///
/// # Errors
///
/// Database failures.
pub async fn summary(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<Vec<(String, String, i64)>, AppError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT kind, state, COUNT(*) FROM sync_jobs \
             WHERE (origin_tenant_id = $1 OR target_tenant_id = $1) \
               AND state NOT IN ('done', 'superseded', 'inactive', 'cancelled') \
             GROUP BY kind, state ORDER BY kind, state",
            [tenant_id.into()],
        ))
        .await?;
    rows.iter()
        .map(|row| -> Result<(String, String, i64), AppError> {
            Ok((
                row.try_get_by_index(0)?,
                row.try_get_by_index(1)?,
                row.try_get_by_index(2)?,
            ))
        })
        .collect()
}
