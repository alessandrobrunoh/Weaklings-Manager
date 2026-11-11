//! Tenant outbox: emit (in the caller's transaction), leased claim, ack / fail / extend,
//! expiry, reclaim of crashed leases, and config re-arm.
//!
//! Every mutation after a claim is fenced by `lease_token` (a stale token gets `Conflict`,
//! the caller discards its result). Claims are exclusive by the conditional `UPDATE`
//! (`state = 'pending'`), so two claimers never obtain the same row; the head-of-line rule
//! is re-checked inside that `UPDATE`.
//!
//! Time is always passed in (`now`), never read from the database, so SQLite tests and the
//! PostgreSQL integration tests share one clock.

use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use sea_orm::{ConnectionTrait, DbBackend, DbErr, QueryResult, Statement, Value};
use serde_json::Value as Json;
use uuid::Uuid;

use super::kinds::{Cause, EffectKind, EntityType, keys};
use crate::{backoff::BackoffPolicy, fence::LeaseFence};
use backend_core::errors::AppError;

/// Retry curve of a failed delivery: `min(15 min, 10 s * 2^(attempts - 1))`, +-20 % jitter.
pub const DELIVERY_RETRY: BackoffPolicy = BackoffPolicy {
    base: StdDuration::from_secs(10),
    cap: StdDuration::from_secs(900),
    max_exponent: 8,
    jitter: 0.2,
};

/// State of an outbox row (`discord_outbox.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxState {
    /// Waiting to be claimed.
    Pending,
    /// Claimed by a bot instance under a lease.
    Leased,
    /// Executed.
    Done,
    /// Intentionally not executed (config, expiry, entity gone, ...).
    Skipped,
    /// Gave up (permission, gone, fatal or attempts exhausted).
    Failed,
    /// Outcome unknown; needs a human.
    Ambiguous,
    /// Replaced by a newer effect of the same entity.
    Superseded,
}

impl OutboxState {
    /// Stored label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Leased => "leased",
            Self::Done => "done",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Ambiguous => "ambiguous",
            Self::Superseded => "superseded",
        }
    }

    /// Parses the stored label.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::Pending,
            Self::Leased,
            Self::Done,
            Self::Skipped,
            Self::Failed,
            Self::Ambiguous,
            Self::Superseded,
        ]
        .into_iter()
        .find(|state| state.as_str() == value)
    }
}

/// One effect to enqueue.
#[derive(Debug, Clone, PartialEq)]
pub struct Effect {
    /// Effect kind; its policy decides class, priority and supersession.
    pub kind: EffectKind,
    /// Entity id (0 for tenant singletons).
    pub entity_id: i64,
    /// Small JSON payload. Never rendered state: the reducer re-reads the entity.
    pub payload: Json,
    /// Entity fingerprint at emit time (diagnostics and the drift sweep).
    pub fingerprint: Option<String>,
    /// Discriminator for the keys of the kind (schedule epoch, status, bucket).
    pub key_suffix: Option<String>,
    /// Not-before time; `None` means now.
    pub available_at: Option<DateTime<Utc>>,
    /// Past this instant a pending row becomes `skipped(expired)`.
    pub expires_at: Option<DateTime<Utc>>,
}

impl Effect {
    /// An effect with an empty payload that is due now and never expires.
    #[must_use]
    pub fn new(kind: EffectKind, entity_id: i64) -> Self {
        Self {
            kind,
            entity_id,
            payload: Json::Object(serde_json::Map::new()),
            fingerprint: None,
            key_suffix: None,
            available_at: None,
            expires_at: None,
        }
    }
}

/// What `emit` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitOutcome {
    /// A new row was inserted.
    Inserted(i64),
    /// A pending row with the same coalesce key was refreshed in place.
    Coalesced(i64),
    /// The once key already exists (the effect was executed or queued before).
    AlreadyDone,
}

/// Full view of an outbox row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// Row id, also the per-tenant ordering key.
    pub id: i64,
    /// Effect kind.
    pub kind: EffectKind,
    /// Entity type label.
    pub entity_type: String,
    /// Entity id.
    pub entity_id: i64,
    /// Parsed payload.
    pub payload: Json,
    /// Cause label.
    pub cause: String,
    /// Row state.
    pub state: OutboxState,
    /// Claim priority.
    pub priority: i16,
    /// Not-before time.
    pub available_at: DateTime<Utc>,
    /// Expiry instant.
    pub expires_at: Option<DateTime<Utc>>,
    /// Coalesce key (unique while pending).
    pub coalesce_key: Option<String>,
    /// Once key (unique forever).
    pub once_key: Option<String>,
    /// Claims so far.
    pub attempts: i32,
    /// Attempt budget.
    pub max_attempts: i32,
    /// Entity fingerprint at emit time.
    pub fingerprint: Option<String>,
    /// Current lease token while leased.
    pub lease_token: Option<Uuid>,
    /// Current lease deadline while leased.
    pub lease_until: Option<DateTime<Utc>>,
    /// A previous lease expired: a previous execution may have partially run.
    pub recovering: bool,
    /// Class of the last failure or skip.
    pub last_error_class: Option<String>,
    /// Code of the last failure or skip.
    pub last_error_code: Option<String>,
    /// JSON result of the last `done` ack.
    pub result: Option<String>,
}

/// A row leased to a bot instance.
#[derive(Debug, Clone, PartialEq)]
pub struct Claimed {
    /// The row as it is after the claim (attempts already incremented).
    pub row: Row,
    /// Token and deadline; every later call on this row must present the token.
    pub fence: LeaseFence,
}

/// Terminal result of an executed row.
#[derive(Debug, Clone, PartialEq)]
pub enum Completion {
    /// Executed; `result` is stored as JSON.
    Done {
        /// Reducer result (ids, flags).
        result: Option<Json>,
    },
    /// Not executed on purpose, with a machine-readable reason.
    Skipped {
        /// Reason, stored in `last_error_code` (for example `entity_gone`).
        reason: String,
    },
}

/// Failure class of a reducer (DO §6.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailClass {
    /// 429, 5xx, timeouts: retry with backoff.
    Retryable,
    /// Required configuration is missing: skipped until settings change.
    Config,
    /// Missing Discord permission: failed until an admin fixes it.
    Permission,
    /// The Discord object is gone and cannot be recreated.
    Gone,
    /// The side effect may or may not have happened: needs a human.
    Ambiguous,
    /// Programming error or unsupported kind.
    Fatal,
}

impl FailClass {
    /// Stored label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Retryable => "retryable",
            Self::Config => "config",
            Self::Permission => "permission",
            Self::Gone => "gone",
            Self::Ambiguous => "ambiguous",
            Self::Fatal => "fatal",
        }
    }
}

/// A failed attempt reported by a reducer.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    /// Failure class.
    pub class: FailClass,
    /// Machine-readable code (`discord:50013`, `unconfigured:events_channel`).
    pub code: Option<String>,
    /// Human-readable message, stored in `last_error`.
    pub message: String,
    /// `false` gives the attempt back (voice "still occupied" retries are free).
    pub count_attempt: bool,
    /// Explicit delay for a retry, instead of the backoff curve.
    pub retry_after: Option<Duration>,
}

impl Failure {
    /// A retryable failure that consumes an attempt and uses the backoff curve.
    #[must_use]
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            class: FailClass::Retryable,
            code: None,
            message: message.into(),
            count_attempt: true,
            retry_after: None,
        }
    }

    /// A failure of the given class with no code.
    #[must_use]
    pub fn of(class: FailClass, message: impl Into<String>) -> Self {
        Self {
            class,
            code: None,
            message: message.into(),
            count_attempt: true,
            retry_after: None,
        }
    }
}

/// The state transition a failure produces, computed without touching the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailPlan {
    /// New row state.
    pub state: OutboxState,
    /// New attempt count.
    pub attempts: i32,
    /// New not-before time when the row is retried.
    pub available_at: Option<DateTime<Utc>>,
}

/// Failure transition table (DO §6.5).
///
/// * `retryable`: `pending` with a backoff (or `retry_after`), `failed` once the budget is
///   spent. `count_attempt = false` gives the claim's attempt back.
/// * `config`: `skipped`, re-armed later by a settings change.
/// * `permission`, `gone`, `fatal`: `failed`.
/// * `ambiguous`: `ambiguous`, never retried automatically.
#[must_use]
pub fn plan_failure(
    now: DateTime<Utc>,
    failure: &Failure,
    attempts: i32,
    max_attempts: i32,
    rng: &mut impl Rng,
) -> FailPlan {
    match failure.class {
        FailClass::Retryable => {
            let attempts = if failure.count_attempt {
                attempts
            } else {
                attempts.saturating_sub(1).max(0)
            };
            let state = if attempts >= max_attempts {
                OutboxState::Failed
            } else {
                OutboxState::Pending
            };
            let delay = failure.retry_after.unwrap_or_else(|| {
                let exponent = attempts.saturating_sub(1).max(0);
                to_chrono(DELIVERY_RETRY.delay(exponent.unsigned_abs(), rng))
            });
            FailPlan {
                state,
                attempts,
                available_at: (state == OutboxState::Pending).then(|| now + delay),
            }
        }
        FailClass::Config => FailPlan {
            state: OutboxState::Skipped,
            attempts,
            available_at: None,
        },
        FailClass::Permission | FailClass::Gone | FailClass::Fatal => FailPlan {
            state: OutboxState::Failed,
            attempts,
            available_at: None,
        },
        FailClass::Ambiguous => FailPlan {
            state: OutboxState::Ambiguous,
            attempts,
            available_at: None,
        },
    }
}

fn to_chrono(delay: StdDuration) -> Duration {
    Duration::milliseconds(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX))
}

const COLUMNS: &str = "id, kind, entity_type, entity_id, payload, fingerprint, cause, state, \
     priority, available_at, expires_at, coalesce_key, once_key, attempts, max_attempts, \
     lease_token, lease_until, recovering, last_error_class, last_error_code, result";

fn stmt(
    backend: DbBackend,
    sql: impl AsRef<str>,
    values: impl IntoIterator<Item = Value>,
) -> Statement {
    Statement::from_sql_and_values(backend, sql.as_ref(), values)
}

fn token_value(backend: DbBackend, token: Uuid) -> Value {
    match backend {
        DbBackend::Postgres => token.into(),
        _ => token.to_string().into(),
    }
}

fn read_token(backend: DbBackend, row: &QueryResult, column: &str) -> Result<Option<Uuid>, DbErr> {
    match backend {
        DbBackend::Postgres => row.try_get::<Option<Uuid>>("", column),
        _ => row
            .try_get::<Option<String>>("", column)?
            .map(|text| Uuid::parse_str(&text).map_err(|err| DbErr::Custom(err.to_string())))
            .transpose(),
    }
}

fn row_from(backend: DbBackend, row: &QueryResult) -> Result<Row, DbErr> {
    let kind: String = row.try_get("", "kind")?;
    let kind = EffectKind::parse(&kind)
        .ok_or_else(|| DbErr::Custom(format!("unknown outbox kind {kind}")))?;
    let state: String = row.try_get("", "state")?;
    let state = OutboxState::parse(&state)
        .ok_or_else(|| DbErr::Custom(format!("unknown outbox state {state}")))?;
    let payload: String = row.try_get("", "payload")?;
    let payload = serde_json::from_str(&payload).map_err(|err| DbErr::Custom(err.to_string()))?;
    Ok(Row {
        id: row.try_get("", "id")?,
        kind,
        entity_type: row.try_get("", "entity_type")?,
        entity_id: row.try_get("", "entity_id")?,
        payload,
        fingerprint: row.try_get("", "fingerprint")?,
        cause: row.try_get("", "cause")?,
        state,
        priority: row.try_get("", "priority")?,
        available_at: row.try_get("", "available_at")?,
        expires_at: row.try_get("", "expires_at")?,
        coalesce_key: row.try_get("", "coalesce_key")?,
        once_key: row.try_get("", "once_key")?,
        attempts: row.try_get("", "attempts")?,
        max_attempts: row.try_get("", "max_attempts")?,
        lease_token: read_token(backend, row, "lease_token")?,
        lease_until: row.try_get("", "lease_until")?,
        recovering: row.try_get("", "recovering")?,
        last_error_class: row.try_get("", "last_error_class")?,
        last_error_code: row.try_get("", "last_error_code")?,
        result: row.try_get("", "result")?,
    })
}

/// Loads one row by id.
///
/// # Errors
///
/// Returns a database error when the query or the row decoding fails.
pub async fn get<C: ConnectionTrait>(conn: &C, id: i64) -> Result<Option<Row>, AppError> {
    let backend = conn.get_database_backend();
    let found = conn
        .query_one(stmt(
            backend,
            format!("SELECT {COLUMNS} FROM discord_outbox WHERE id = $1"),
            [id.into()],
        ))
        .await?;
    found
        .map(|row| row_from(backend, &row))
        .transpose()
        .map_err(AppError::from)
}

/// Enqueues an effect inside the caller's transaction.
///
/// Order of work: policy lookup and key derivation, once-key insert (zero rows means
/// [`EmitOutcome::AlreadyDone`]), or coalesce upsert onto the pending row, then supersession
/// of earlier pending rows of the same entity listed by the policy. A coalesce upsert makes
/// the latest emit the row's intent: kind, entity type, priority, max attempts, cause, actor
/// and payload all come from it, so `event.close` and `event.remove` (one key) never lose
/// the remove.
///
/// # Errors
///
/// Returns `Validation` for a non-zero id on a tenant kind or a missing key suffix, and a
/// database error otherwise.
pub async fn emit<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    cause: Cause,
    actor_user_id: Option<i64>,
    effect: Effect,
) -> Result<EmitOutcome, AppError> {
    let backend = conn.get_database_backend();
    let policy = effect.kind.policy();
    if policy.entity == EntityType::Tenant && effect.entity_id != 0 {
        return Err(AppError::Validation(format!(
            "effect {} is a tenant singleton and takes entity id 0",
            effect.kind
        )));
    }
    let keys = keys(
        effect.kind,
        effect.entity_id,
        cause,
        effect.key_suffix.as_deref(),
    )
    .map_err(|err| AppError::Validation(err.to_string()))?;
    let available_at = effect.available_at.unwrap_or(now);
    let payload = effect.payload.to_string();
    let insert_head = "INSERT INTO discord_outbox (kind, entity_type, entity_id, payload, \
         fingerprint, cause, actor_user_id, state, priority, available_at, expires_at, \
         coalesce_key, once_key, attempts, max_attempts, recovering, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, 0, $13, FALSE, $14, $15)";
    let values = |coalesce: Option<&str>, once: Option<&str>| -> [Value; 15] {
        [
            effect.kind.as_str().into(),
            policy.entity.as_str().into(),
            effect.entity_id.into(),
            payload.clone().into(),
            effect.fingerprint.clone().into(),
            cause.as_str().into(),
            actor_user_id.into(),
            policy.priority.into(),
            available_at.into(),
            effect.expires_at.into(),
            coalesce.map(str::to_owned).into(),
            once.map(str::to_owned).into(),
            policy.max_attempts.into(),
            now.into(),
            now.into(),
        ]
    };

    let id = if let Some(once) = keys.once.as_deref() {
        let inserted = conn
            .query_one(stmt(
                backend,
                format!(
                    "{insert_head} ON CONFLICT (once_key) WHERE once_key IS NOT NULL \
                     DO NOTHING RETURNING id"
                ),
                values(None, Some(once)),
            ))
            .await?;
        match inserted {
            Some(row) => row.try_get::<i64>("", "id")?,
            None => return Ok(EmitOutcome::AlreadyDone),
        }
    } else if let Some(coalesce) = keys.coalesce.as_deref() {
        let existing = conn
            .query_one(stmt(
                backend,
                "SELECT id FROM discord_outbox WHERE coalesce_key = $1 AND state = 'pending'",
                [coalesce.into()],
            ))
            .await?;
        let row = conn
            .query_one(stmt(
                backend,
                format!(
                    "{insert_head} ON CONFLICT (coalesce_key) \
                     WHERE coalesce_key IS NOT NULL AND state = 'pending' \
                     DO UPDATE SET kind = excluded.kind, \
                     entity_type = excluded.entity_type, \
                     priority = excluded.priority, \
                     max_attempts = excluded.max_attempts, \
                     cause = excluded.cause, \
                     actor_user_id = excluded.actor_user_id, \
                     payload = excluded.payload, \
                     fingerprint = excluded.fingerprint, \
                     available_at = CASE WHEN excluded.available_at < discord_outbox.available_at \
                     THEN excluded.available_at ELSE discord_outbox.available_at END, \
                     expires_at = excluded.expires_at, updated_at = excluded.updated_at \
                     RETURNING id"
                ),
                values(Some(coalesce), None),
            ))
            .await?
            .ok_or_else(|| DbErr::Custom("coalesced upsert returned no row".to_owned()))?;
        let id = row.try_get::<i64>("", "id")?;
        let outcome = if existing.is_some() {
            EmitOutcome::Coalesced(id)
        } else {
            EmitOutcome::Inserted(id)
        };
        supersede_earlier(conn, now, &effect, id).await?;
        return Ok(outcome);
    } else {
        let row = conn
            .query_one(stmt(
                backend,
                format!("{insert_head} RETURNING id"),
                values(None, None),
            ))
            .await?
            .ok_or_else(|| DbErr::Custom("outbox insert returned no row".to_owned()))?;
        row.try_get::<i64>("", "id")?
    };
    supersede_earlier(conn, now, &effect, id).await?;
    Ok(EmitOutcome::Inserted(id))
}

/// Marks pending rows of the same entity, listed by the kind's policy, as superseded.
/// Leased rows are never touched: they finish and the head-of-line rule orders the rest.
async fn supersede_earlier<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    effect: &Effect,
    id: i64,
) -> Result<(), AppError> {
    let policy = effect.kind.policy();
    if policy.supersedes.is_empty() {
        return Ok(());
    }
    let backend = conn.get_database_backend();
    let placeholders = placeholders(5, policy.supersedes.len());
    let mut values: Vec<Value> = vec![
        now.into(),
        policy.entity.as_str().into(),
        effect.entity_id.into(),
        id.into(),
    ];
    values.extend(policy.supersedes.iter().map(|kind| kind.as_str().into()));
    conn.execute(stmt(
        backend,
        format!(
            "UPDATE discord_outbox SET state = 'superseded', updated_at = $1 \
             WHERE entity_type = $2 AND entity_id = $3 AND state = 'pending' AND id <> $4 \
             AND kind IN ({placeholders})"
        ),
        values,
    ))
    .await?;
    Ok(())
}

/// `$from, $from+1, ...` (`count` placeholders) for building `IN (...)` lists.
fn placeholders(from: usize, count: usize) -> String {
    (from..from + count)
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Claims up to `limit` due rows for `instance_id` under a lease of `lease`.
///
/// A row is due when it is `pending`, `available_at <= now`, not expired, and no earlier row
/// (lower id) of the same entity is still `pending` or `leased` (per-entity head-of-line).
/// Order: priority descending, then id. Each candidate is taken by a conditional update, so
/// concurrent claimers never receive the same row.
///
/// # Errors
///
/// Returns `Validation` for a zero limit or a non-positive lease, and a database error otherwise.
pub async fn claim_due<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    instance_id: &str,
    lease: Duration,
    limit: u64,
) -> Result<Vec<Claimed>, AppError> {
    if limit == 0 || lease <= Duration::zero() {
        return Err(AppError::Validation(
            "outbox claim needs a positive limit and lease".to_owned(),
        ));
    }
    let backend = conn.get_database_backend();
    let candidates = conn
        .query_all(stmt(
            backend,
            "SELECT o.id FROM discord_outbox o \
             WHERE o.state = 'pending' AND o.available_at <= $1 \
             AND (o.expires_at IS NULL OR o.expires_at > $1) \
             AND NOT EXISTS (SELECT 1 FROM discord_outbox e \
                 WHERE e.entity_type = o.entity_type AND e.entity_id = o.entity_id \
                 AND e.id < o.id AND e.state IN ('pending', 'leased')) \
             ORDER BY o.priority DESC, o.id ASC LIMIT $2",
            [now.into(), i64::try_from(limit).unwrap_or(i64::MAX).into()],
        ))
        .await?;

    let mut claimed = Vec::new();
    for candidate in candidates {
        let id: i64 = candidate.try_get("", "id")?;
        let fence = LeaseFence::new(now, lease);
        let taken = conn
            .query_one(stmt(
                backend,
                format!(
                    "UPDATE discord_outbox SET state = 'leased', lease_token = $1, \
                     lease_until = $2, leased_by = $3, attempts = attempts + 1, updated_at = $4 \
                     WHERE id = $5 AND state = 'pending' AND available_at <= $6 \
                     AND (expires_at IS NULL OR expires_at > $6) \
                     AND NOT EXISTS (SELECT 1 FROM discord_outbox e \
                         WHERE e.entity_type = discord_outbox.entity_type \
                         AND e.entity_id = discord_outbox.entity_id \
                         AND e.id < discord_outbox.id AND e.state IN ('pending', 'leased')) \
                     RETURNING {COLUMNS}"
                ),
                [
                    token_value(backend, fence.token()),
                    fence.until().into(),
                    instance_id.into(),
                    now.into(),
                    id.into(),
                    now.into(),
                ],
            ))
            .await?;
        if let Some(row) = taken {
            claimed.push(Claimed {
                row: row_from(backend, &row)?,
                fence,
            });
        }
    }
    Ok(claimed)
}

fn lease_lost(id: i64) -> AppError {
    AppError::Conflict(format!("outbox item {id} lease expired or was replaced"))
}

/// Looks up the leased row a fenced call refers to, returning its attempt budget and
/// current `available_at`.
async fn held_row<C: ConnectionTrait>(
    conn: &C,
    id: i64,
    token: Uuid,
) -> Result<(i32, i32, DateTime<Utc>), AppError> {
    let backend = conn.get_database_backend();
    let row = conn
        .query_one(stmt(
            backend,
            "SELECT attempts, max_attempts, available_at FROM discord_outbox \
             WHERE id = $1 AND state = 'leased' AND lease_token = $2",
            [id.into(), token_value(backend, token)],
        ))
        .await?
        .ok_or_else(|| lease_lost(id))?;
    Ok((
        row.try_get("", "attempts")?,
        row.try_get("", "max_attempts")?,
        row.try_get("", "available_at")?,
    ))
}

/// Records the terminal result of a leased row. Fenced by `token`.
///
/// # Errors
///
/// Returns `Conflict` (`lease expired or was replaced`) when the token no longer holds the row.
pub async fn ack<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    id: i64,
    token: Uuid,
    completion: Completion,
) -> Result<OutboxState, AppError> {
    let backend = conn.get_database_backend();
    let (state, sql, values): (OutboxState, &str, Vec<Value>) = match completion {
        Completion::Done { result } => (
            OutboxState::Done,
            "UPDATE discord_outbox SET state = 'done', done_at = $1, updated_at = $1, \
             result = $2, lease_token = NULL, lease_until = NULL, leased_by = NULL, \
             recovering = FALSE WHERE id = $3 AND state = 'leased' AND lease_token = $4",
            vec![
                now.into(),
                result.map(|value| value.to_string()).into(),
                id.into(),
                token_value(backend, token),
            ],
        ),
        Completion::Skipped { reason } => (
            OutboxState::Skipped,
            "UPDATE discord_outbox SET state = 'skipped', done_at = $1, updated_at = $1, \
             last_error_code = $2, lease_token = NULL, lease_until = NULL, leased_by = NULL, \
             recovering = FALSE WHERE id = $3 AND state = 'leased' AND lease_token = $4",
            vec![
                now.into(),
                reason.into(),
                id.into(),
                token_value(backend, token),
            ],
        ),
    };
    let affected = conn
        .execute(stmt(backend, sql, values))
        .await?
        .rows_affected();
    LeaseFence::ensure_held(affected, &format!("outbox item {id}"))?;
    Ok(state)
}

/// Reports a failed attempt. Fenced by `token`. Returns the new state.
///
/// # Errors
///
/// Returns `Conflict` when the token no longer holds the row.
pub async fn fail<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    id: i64,
    token: Uuid,
    failure: &Failure,
) -> Result<OutboxState, AppError> {
    let backend = conn.get_database_backend();
    let (attempts, max_attempts, current_available_at) = held_row(conn, id, token).await?;
    let plan = {
        let mut rng = rand::thread_rng();
        plan_failure(now, failure, attempts, max_attempts, &mut rng)
    };
    let affected = conn
        .execute(stmt(
            backend,
            "UPDATE discord_outbox SET state = $1, attempts = $2, available_at = $3, \
             last_error = $4, last_error_class = $5, last_error_code = $6, lease_token = NULL, \
             lease_until = NULL, leased_by = NULL, updated_at = $7 \
             WHERE id = $8 AND state = 'leased' AND lease_token = $9",
            [
                plan.state.as_str().into(),
                plan.attempts.into(),
                plan.available_at.unwrap_or(current_available_at).into(),
                failure.message.clone().into(),
                failure.class.as_str().into(),
                failure.code.clone().into(),
                now.into(),
                id.into(),
                token_value(backend, token),
            ],
        ))
        .await?
        .rows_affected();
    LeaseFence::ensure_held(affected, &format!("outbox item {id}"))?;
    Ok(plan.state)
}

/// Extends the lease of a row to `now + lease`. Fenced by `token`.
///
/// # Errors
///
/// Returns `Conflict` when the token no longer holds the row.
pub async fn extend<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    id: i64,
    token: Uuid,
    lease: Duration,
) -> Result<LeaseFence, AppError> {
    let backend = conn.get_database_backend();
    let until = now + lease;
    let affected = conn
        .execute(stmt(
            backend,
            "UPDATE discord_outbox SET lease_until = $1 \
             WHERE id = $2 AND state = 'leased' AND lease_token = $3",
            [until.into(), id.into(), token_value(backend, token)],
        ))
        .await?
        .rows_affected();
    LeaseFence::ensure_held(affected, &format!("outbox item {id}"))?;
    Ok(LeaseFence::with_token(token, until))
}

/// Turns pending rows past their `expires_at` into `skipped(expired)`. Returns the count.
///
/// # Errors
///
/// Returns a database error when the update fails.
pub async fn expire_due<C: ConnectionTrait>(conn: &C, now: DateTime<Utc>) -> Result<u64, AppError> {
    let backend = conn.get_database_backend();
    let affected = conn
        .execute(stmt(
            backend,
            "UPDATE discord_outbox SET state = 'skipped', last_error_class = 'expired', \
             last_error_code = 'expired', done_at = $1, updated_at = $1 \
             WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1",
            [now.into()],
        ))
        .await?
        .rows_affected();
    Ok(affected)
}

/// Returns leases whose deadline passed to the queue. Each reclaimed row is marked
/// `recovering` (a previous execution may have partially run). A row that already used its
/// whole attempt budget becomes `ambiguous` instead of being retried. Returns the count.
///
/// # Errors
///
/// Returns a database error when the update fails.
pub async fn reclaim_expired<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
) -> Result<u64, AppError> {
    let backend = conn.get_database_backend();
    let affected = conn
        .execute(stmt(
            backend,
            "UPDATE discord_outbox SET \
             state = CASE WHEN attempts >= max_attempts THEN 'ambiguous' ELSE 'pending' END, \
             last_error_class = CASE WHEN attempts >= max_attempts THEN 'ambiguous' \
                 ELSE last_error_class END, \
             lease_token = NULL, lease_until = NULL, leased_by = NULL, recovering = TRUE, \
             updated_at = $1 \
             WHERE state = 'leased' AND lease_until <= $1",
            [now.into()],
        ))
        .await?
        .rows_affected();
    Ok(affected)
}

/// Re-arms `skipped(config)` rows of the given kinds and codes back to `pending` with a fresh
/// budget. Called after the setting they were waiting for changed. Returns the count.
///
/// # Errors
///
/// Returns a database error when the update fails.
pub async fn rearm_config<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    kinds: &[EffectKind],
    codes: &[String],
) -> Result<u64, AppError> {
    if kinds.is_empty() || codes.is_empty() {
        return Ok(0);
    }
    let backend = conn.get_database_backend();
    let kind_list = placeholders(3, kinds.len());
    let code_list = placeholders(3 + kinds.len(), codes.len());
    let mut values: Vec<Value> = vec![now.into(), now.into()];
    values.extend(kinds.iter().map(|kind| kind.as_str().into()));
    values.extend(codes.iter().map(|code| code.as_str().into()));
    let affected = conn
        .execute(stmt(
            backend,
            format!(
                "UPDATE discord_outbox SET state = 'pending', attempts = 0, available_at = $1, \
                 last_error_class = NULL, last_error_code = NULL, updated_at = $2 \
                 WHERE state = 'skipped' AND last_error_class = 'config' \
                 AND kind IN ({kind_list}) AND last_error_code IN ({code_list})"
            ),
            values,
        ))
        .await?
        .rows_affected();
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    async fn sqlite() -> sea_orm::DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).expect("timestamp")
    }

    async fn emit_plain(
        db: &impl ConnectionTrait,
        now: DateTime<Utc>,
        effect: Effect,
    ) -> EmitOutcome {
        emit(db, now, Cause::Web, None, effect).await.expect("emit")
    }

    fn event(kind: EffectKind, id: i64) -> Effect {
        Effect::new(kind, id)
    }

    fn with_suffix(kind: EffectKind, id: i64, suffix: &str) -> Effect {
        Effect {
            key_suffix: Some(suffix.to_owned()),
            ..Effect::new(kind, id)
        }
    }

    async fn state_of(db: &impl ConnectionTrait, id: i64) -> OutboxState {
        get(db, id).await.expect("get").expect("row").state
    }

    #[tokio::test]
    async fn once_key_makes_the_second_emit_a_no_op() {
        let db = sqlite().await;
        let first = emit_plain(&db, at(0), with_suffix(EffectKind::EventMass, 7, "1700")).await;
        let second = emit_plain(&db, at(5), with_suffix(EffectKind::EventMass, 7, "1700")).await;
        assert!(matches!(first, EmitOutcome::Inserted(_)));
        assert_eq!(second, EmitOutcome::AlreadyDone);
        let other_epoch =
            emit_plain(&db, at(5), with_suffix(EffectKind::EventMass, 7, "9999")).await;
        assert!(matches!(other_epoch, EmitOutcome::Inserted(_)));
    }

    #[tokio::test]
    async fn coalescing_keeps_one_pending_row_with_the_earliest_available_time() {
        let db = sqlite().await;
        let later = Effect {
            available_at: Some(at(100)),
            fingerprint: Some("v1".to_owned()),
            ..event(EffectKind::EventUpsert, 3)
        };
        let first = emit_plain(&db, at(0), later).await;
        let EmitOutcome::Inserted(id) = first else {
            panic!("first upsert must insert, got {first:?}");
        };
        let refresh = Effect {
            available_at: Some(at(10)),
            fingerprint: Some("v2".to_owned()),
            ..event(EffectKind::EventUpsert, 3)
        };
        let second = emit_plain(&db, at(1), refresh).await;
        assert_eq!(second, EmitOutcome::Coalesced(id));
        let row = get(&db, id).await.expect("get").expect("row");
        assert_eq!(row.fingerprint.as_deref(), Some("v2"));
        assert_eq!(row.available_at, at(10));
        assert_eq!(count_pending(&db, "event:3").await, 1);
    }

    async fn count_pending(db: &impl ConnectionTrait, coalesce: &str) -> i64 {
        db.query_one(stmt(
            db.get_database_backend(),
            "SELECT COUNT(*) AS n FROM discord_outbox WHERE coalesce_key = $1 AND state = 'pending'",
            [coalesce.into()],
        ))
        .await
        .expect("count")
        .expect("row")
        .try_get::<i64>("", "n")
        .expect("n")
    }

    #[tokio::test]
    async fn close_then_remove_coalesces_into_one_row_that_carries_the_remove_intent() {
        let db = sqlite().await;
        let close = emit_plain(&db, at(0), event(EffectKind::EventClose, 5)).await;
        let EmitOutcome::Inserted(close_id) = close else {
            panic!("first close must insert, got {close:?}");
        };
        let remove = emit_plain(&db, at(1), event(EffectKind::EventRemove, 5)).await;
        assert_eq!(remove, EmitOutcome::Coalesced(close_id));
        assert_eq!(count_pending(&db, "event-close:5").await, 1);
        let row = get(&db, close_id).await.expect("get").expect("row");
        assert_eq!(row.kind, EffectKind::EventRemove);
        assert_eq!(
            row.priority,
            crate::discord_delivery::kinds::PRIORITY_LIFECYCLE
        );
        assert_eq!(
            row.max_attempts,
            EffectKind::EventRemove.policy().max_attempts
        );
    }

    #[tokio::test]
    async fn remove_then_close_coalesces_and_the_latest_intent_wins() {
        let db = sqlite().await;
        let remove = emit_plain(&db, at(0), event(EffectKind::EventRemove, 6)).await;
        let EmitOutcome::Inserted(remove_id) = remove else {
            panic!("first remove must insert, got {remove:?}");
        };
        let close = emit_plain(&db, at(1), event(EffectKind::EventClose, 6)).await;
        assert_eq!(close, EmitOutcome::Coalesced(remove_id));
        assert_eq!(count_pending(&db, "event-close:6").await, 1);
        let row = get(&db, remove_id).await.expect("get").expect("row");
        assert_eq!(row.kind, EffectKind::EventClose);
        assert_eq!(
            row.priority,
            crate::discord_delivery::kinds::PRIORITY_LIFECYCLE
        );
    }

    #[tokio::test]
    async fn supersession_matrix_marks_only_listed_pending_rows_of_the_same_entity() {
        let db = sqlite().await;
        let upsert = emit_plain(&db, at(0), event(EffectKind::EventUpsert, 1)).await;
        let mass = emit_plain(&db, at(0), with_suffix(EffectKind::EventMass, 1, "a")).await;
        let other_event = emit_plain(&db, at(0), event(EffectKind::EventUpsert, 2)).await;
        let EmitOutcome::Inserted(upsert_id) = upsert else {
            panic!("insert")
        };
        let EmitOutcome::Inserted(mass_id) = mass else {
            panic!("insert")
        };
        let EmitOutcome::Inserted(other_id) = other_event else {
            panic!("insert")
        };

        let close = emit_plain(&db, at(1), event(EffectKind::EventClose, 1)).await;
        assert!(matches!(close, EmitOutcome::Inserted(_)));

        assert_eq!(state_of(&db, upsert_id).await, OutboxState::Superseded);
        assert_eq!(state_of(&db, mass_id).await, OutboxState::Superseded);
        assert_eq!(state_of(&db, other_id).await, OutboxState::Pending);

        // A kind outside the list never supersedes: a second reminder leaves the mass alone.
        let remind = emit(
            &db,
            at(2),
            Cause::Scheduler,
            None,
            with_suffix(EffectKind::EventReminder, 1, "r"),
        )
        .await
        .expect("emit");
        assert!(matches!(remind, EmitOutcome::Inserted(_)));
    }

    #[tokio::test]
    async fn start_supersedes_pending_mass_and_reminder_but_not_a_leased_one() {
        let db = sqlite().await;
        let mass = emit_plain(&db, at(0), with_suffix(EffectKind::EventMass, 4, "m")).await;
        let reminder = emit_plain(&db, at(0), with_suffix(EffectKind::EventReminder, 4, "r")).await;
        let EmitOutcome::Inserted(mass_id) = mass else {
            panic!("insert")
        };
        let EmitOutcome::Inserted(reminder_id) = reminder else {
            panic!("insert")
        };
        let claimed = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 1)
            .await
            .expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].row.id, mass_id);

        emit_plain(&db, at(1), with_suffix(EffectKind::EventStart, 4, "s")).await;
        assert_eq!(state_of(&db, mass_id).await, OutboxState::Leased);
        assert_eq!(state_of(&db, reminder_id).await, OutboxState::Superseded);
    }

    #[tokio::test]
    async fn head_of_line_blocks_later_rows_of_the_same_entity_only() {
        let db = sqlite().await;
        let delayed = Effect {
            available_at: Some(at(60)),
            ..event(EffectKind::EventUpsert, 10)
        };
        let delayed_id = match emit_plain(&db, at(0), delayed).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let blocked =
            match emit_plain(&db, at(0), with_suffix(EffectKind::EventMass, 10, "m")).await {
                EmitOutcome::Inserted(id) => id,
                other => panic!("unexpected {other:?}"),
            };
        let other_entity = match emit_plain(&db, at(0), event(EffectKind::EventUpsert, 11)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        assert_ne!(delayed_id, blocked);

        let claimed = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 10)
            .await
            .expect("claim");
        let ids: Vec<i64> = claimed.iter().map(|c| c.row.id).collect();
        assert_eq!(ids, vec![other_entity], "same-entity rows must wait");
    }

    #[tokio::test]
    async fn claims_are_ordered_by_priority_then_id_and_never_duplicated() {
        let db = sqlite().await;
        let low = match emit_plain(&db, at(0), event(EffectKind::CalendarSync, 0)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let high = match emit_plain(&db, at(0), with_suffix(EffectKind::EventMass, 2, "x")).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let first = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 1)
            .await
            .expect("claim");
        assert_eq!(first[0].row.id, high);
        let second = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 5)
            .await
            .expect("claim");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].row.id, low);
        let none = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 5)
            .await
            .expect("claim");
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn stale_token_is_fenced_out_of_ack_fail_and_extend() {
        let db = sqlite().await;
        let id = match emit_plain(&db, at(0), event(EffectKind::EventUpsert, 5)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let first = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 1)
            .await
            .expect("claim")
            .remove(0);
        // The lease expires and another instance takes the row over.
        assert_eq!(reclaim_expired(&db, at(100)).await.expect("reclaim"), 1);
        let second = claim_due(&db, at(100), "bot-b", Duration::seconds(90), 1)
            .await
            .expect("claim")
            .remove(0);
        assert_eq!(second.row.attempts, 2);
        assert!(
            second.row.recovering,
            "reclaimed rows are marked recovering"
        );

        let stale = ack(
            &db,
            at(101),
            id,
            first.fence.token(),
            Completion::Done { result: None },
        )
        .await
        .expect_err("stale ack must be refused");
        assert!(matches!(stale, AppError::Conflict(_)));
        assert!(
            extend(&db, at(101), id, first.fence.token(), Duration::seconds(90))
                .await
                .is_err()
        );
        assert!(
            fail(
                &db,
                at(101),
                id,
                first.fence.token(),
                &Failure::retryable("x")
            )
            .await
            .is_err()
        );

        let state = ack(
            &db,
            at(102),
            id,
            second.fence.token(),
            Completion::Done {
                result: Some(serde_json::json!({ "message_id": "9" })),
            },
        )
        .await
        .expect("fresh ack");
        assert_eq!(state, OutboxState::Done);
        let row = get(&db, id).await.expect("get").expect("row");
        assert!(!row.recovering);
        assert_eq!(row.result.as_deref(), Some("{\"message_id\":\"9\"}"));
    }

    #[tokio::test]
    async fn expiry_turns_pending_rows_into_skipped_and_claims_ignore_them() {
        let db = sqlite().await;
        let effect = Effect {
            expires_at: Some(at(30)),
            ..with_suffix(EffectKind::EventStart, 8, "s")
        };
        let id = match emit_plain(&db, at(0), effect).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        assert!(
            claim_due(&db, at(31), "bot-a", Duration::seconds(90), 5)
                .await
                .expect("claim")
                .is_empty()
        );
        assert_eq!(expire_due(&db, at(31)).await.expect("expire"), 1);
        let row = get(&db, id).await.expect("get").expect("row");
        assert_eq!(row.state, OutboxState::Skipped);
        assert_eq!(row.last_error_code.as_deref(), Some("expired"));
    }

    #[tokio::test]
    async fn ack_skipped_records_the_reason() {
        let db = sqlite().await;
        let id = match emit_plain(&db, at(0), event(EffectKind::EventUpsert, 6)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let claim = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 1)
            .await
            .expect("claim")
            .remove(0);
        let state = ack(
            &db,
            at(1),
            id,
            claim.fence.token(),
            Completion::Skipped {
                reason: "entity_gone".to_owned(),
            },
        )
        .await
        .expect("ack");
        assert_eq!(state, OutboxState::Skipped);
        assert_eq!(
            get(&db, id)
                .await
                .expect("get")
                .expect("row")
                .last_error_code
                .as_deref(),
            Some("entity_gone")
        );
    }

    #[test]
    fn fail_class_transitions_follow_the_table() {
        let mut rng = StdRng::seed_from_u64(11);
        let now = at(0);
        let retry = plan_failure(now, &Failure::retryable("429"), 1, 8, &mut rng);
        assert_eq!(retry.state, OutboxState::Pending);
        assert_eq!(retry.attempts, 1);

        let exhausted = plan_failure(now, &Failure::retryable("429"), 8, 8, &mut rng);
        assert_eq!(exhausted.state, OutboxState::Failed);
        assert_eq!(exhausted.available_at, None);

        let free = Failure {
            count_attempt: false,
            retry_after: Some(Duration::seconds(120)),
            ..Failure::retryable("occupied")
        };
        let plan = plan_failure(now, &free, 3, 8, &mut rng);
        assert_eq!(plan.state, OutboxState::Pending);
        assert_eq!(plan.attempts, 2, "attempt given back");
        assert_eq!(plan.available_at, Some(now + Duration::seconds(120)));

        let table = [
            (FailClass::Config, OutboxState::Skipped),
            (FailClass::Permission, OutboxState::Failed),
            (FailClass::Gone, OutboxState::Failed),
            (FailClass::Fatal, OutboxState::Failed),
            (FailClass::Ambiguous, OutboxState::Ambiguous),
        ];
        for (class, state) in table {
            let plan = plan_failure(now, &Failure::of(class, "x"), 2, 8, &mut rng);
            assert_eq!(plan.state, state, "{class:?}");
            assert_eq!(plan.available_at, None, "{class:?}");
        }
    }

    #[test]
    fn delivery_backoff_values_match_the_design() {
        assert_eq!(DELIVERY_RETRY.base_delay(0), StdDuration::from_secs(10));
        assert_eq!(DELIVERY_RETRY.base_delay(1), StdDuration::from_secs(20));
        assert_eq!(DELIVERY_RETRY.base_delay(2), StdDuration::from_secs(40));
        assert_eq!(DELIVERY_RETRY.base_delay(7), StdDuration::from_secs(900));
        let mut rng = StdRng::seed_from_u64(5);
        for _ in 0..100 {
            let delay = plan_failure(at(0), &Failure::retryable("x"), 3, 8, &mut rng)
                .available_at
                .expect("pending")
                - at(0);
            let seconds = delay.num_milliseconds() as f64 / 1000.0;
            assert!((32.0..48.0).contains(&seconds), "{seconds}");
        }
    }

    #[tokio::test]
    async fn reclaim_marks_exhausted_rows_ambiguous_instead_of_retrying() {
        let db = sqlite().await;
        let id = match emit_plain(&db, at(0), event(EffectKind::DmSend, 3)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        // Burn the whole budget through expired leases.
        let mut when = 0;
        for _ in 0..8 {
            let claimed = claim_due(&db, at(when), "bot-a", Duration::seconds(90), 1)
                .await
                .expect("claim");
            assert_eq!(claimed.len(), 1);
            when += 100;
            reclaim_expired(&db, at(when)).await.expect("reclaim");
        }
        let row = get(&db, id).await.expect("get").expect("row");
        assert_eq!(row.state, OutboxState::Ambiguous);
        assert_eq!(row.attempts, 8);
    }

    #[tokio::test]
    async fn rearm_returns_config_skipped_rows_with_a_fresh_budget() {
        let db = sqlite().await;
        let id = match emit_plain(&db, at(0), event(EffectKind::EventUpsert, 12)).await {
            EmitOutcome::Inserted(id) => id,
            other => panic!("unexpected {other:?}"),
        };
        let claim = claim_due(&db, at(0), "bot-a", Duration::seconds(90), 1)
            .await
            .expect("claim")
            .remove(0);
        fail(
            &db,
            at(1),
            id,
            claim.fence.token(),
            &Failure {
                class: FailClass::Config,
                code: Some("unconfigured:events_channel".to_owned()),
                message: "no channel".to_owned(),
                count_attempt: true,
                retry_after: None,
            },
        )
        .await
        .expect("fail");
        assert_eq!(state_of(&db, id).await, OutboxState::Skipped);

        let unrelated = rearm_config(
            &db,
            at(2),
            &[EffectKind::EventUpsert],
            &["unconfigured:voice_category".to_owned()],
        )
        .await
        .expect("rearm");
        assert_eq!(unrelated, 0);

        let rearmed = rearm_config(
            &db,
            at(3),
            &[EffectKind::EventUpsert],
            &["unconfigured:events_channel".to_owned()],
        )
        .await
        .expect("rearm");
        assert_eq!(rearmed, 1);
        let row = get(&db, id).await.expect("get").expect("row");
        assert_eq!(row.state, OutboxState::Pending);
        assert_eq!(row.attempts, 0);
        assert_eq!(row.last_error_code, None);
    }

    #[tokio::test]
    async fn tenant_kinds_reject_a_non_zero_entity_id() {
        let db = sqlite().await;
        let err = emit(
            &db,
            at(0),
            Cause::Scheduler,
            None,
            Effect::new(EffectKind::CalendarSync, 4),
        )
        .await
        .expect_err("tenant kinds take entity 0");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn claim_rejects_degenerate_arguments() {
        let db = sqlite().await;
        assert!(
            claim_due(&db, at(0), "bot-a", Duration::seconds(90), 0)
                .await
                .is_err()
        );
        assert!(
            claim_due(&db, at(0), "bot-a", Duration::zero(), 1)
                .await
                .is_err()
        );
    }
}
