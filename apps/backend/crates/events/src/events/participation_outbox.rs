//! Durable outbox for self-service participation forwarded to alliance event copies.
//!
//! A join or leave is saved on the caller's tenant first; the forward to every other copy
//! then runs against this outbox. One row per (origin event, peer tenant, participant)
//! carries the latest intended state of that participant on that peer: a newer intent
//! overwrites the row (bumping `revision` and re-arming its attempts), so a retry never
//! resurrects someone who has since left. A row exists only until the peer took the change,
//! or until its attempts are spent (`exhausted`, kept for operators, and so the roster sweep
//! keeps its hands off a lost leave).
//!
//! A delivery leases its row for its whole duration, which serialises the synchronous fast
//! path and the retry worker per participant and peer without holding a connection open.

#[cfg(test)]
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, Value};
use uuid::Uuid;

use crate::events::models::ParticipateEventRequest;
use backend_core::errors::AppError;

/// Delivery attempts (the synchronous one included) before an entry is parked.
pub const MAX_ATTEMPTS: i32 = 12;
/// How long a delivery owns its entry before another may take it over.
const LEASE_SECONDS: i64 = 60;
/// Entries retried per worker tick.
pub const MAX_FORWARDS_PER_TICK: i64 = 50;

/// Identifies one participant on one peer copy of an origin event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardKey {
    /// Tenant owning the canonical (origin) event.
    pub origin_tenant_id: String,
    /// Canonical event id.
    pub origin_event_id: i64,
    /// Tenant holding the copy to update.
    pub peer_tenant_id: String,
    /// Participant.
    pub discord_id: String,
}

impl ForwardKey {
    fn values(&self) -> [Value; 4] {
        [
            self.origin_tenant_id.clone().into(),
            self.origin_event_id.into(),
            self.peer_tenant_id.clone().into(),
            self.discord_id.clone().into(),
        ]
    }
}

/// The change to apply on the peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// Sign up (or change builds); the ids belong to `from_tenant_id`.
    Join {
        primary_build_id: Option<i64>,
        secondary_build_id: Option<i64>,
    },
    /// Remove the signup; a peer without one is already in the wanted state.
    Leave,
}

impl Intent {
    #[must_use]
    pub fn from_request(request: Option<&ParticipateEventRequest>) -> Self {
        request.map_or(Self::Leave, |request| Self::Join {
            primary_build_id: request.primary_build_id,
            secondary_build_id: request.secondary_build_id,
        })
    }

    fn operation(&self) -> &'static str {
        match self {
            Self::Join { .. } => "join",
            Self::Leave => "leave",
        }
    }
}

/// An outbox entry leased for delivery.
#[derive(Debug, Clone)]
pub struct PendingForward {
    /// Which participant on which peer.
    pub key: ForwardKey,
    /// The peer copy's event id.
    pub peer_event_id: i64,
    /// Display name used if the peer has to create the user.
    pub username: String,
    /// Tenant whose build ids `intent` carries.
    pub from_tenant_id: String,
    /// Latest intended state.
    pub intent: Intent,
    /// Failed attempts so far.
    pub attempts: i32,
    /// Bumped by every newer intent; fences the outcome of a superseded delivery.
    revision: i64,
    /// Identifies this delivery's lease.
    lease_token: Uuid,
}

impl PendingForward {
    fn values_with_revision(&self) -> [Value; 5] {
        let [a, b, c, d] = self.key.values();
        [a, b, c, d, self.revision.into()]
    }
}

/// Operator-visible state of an entry.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardStatus {
    pub peer_tenant_id: String,
    pub discord_id: String,
    pub operation: String,
    pub state: String,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub next_attempt_at: DateTime<Utc>,
}

/// What a failed attempt led to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureDisposition {
    /// Scheduled for another attempt.
    Retry,
    /// Attempts spent; parked until an operator intervenes.
    Exhausted,
}

/// Writes (or overwrites) the intended state before any delivery is attempted, so a crash or
/// a failed delivery leaves a durable record. The first scheduled attempt is deferred briefly
/// so the worker does not race the synchronous fast path.
pub async fn record_intent(
    control: &DatabaseConnection,
    key: &ForwardKey,
    peer_event_id: i64,
    username: &str,
    from_tenant_id: &str,
    intent: &Intent,
) -> Result<(), AppError> {
    let (primary, secondary) = match intent {
        Intent::Join {
            primary_build_id,
            secondary_build_id,
        } => (*primary_build_id, *secondary_build_id),
        Intent::Leave => (None, None),
    };
    let [origin_tenant, origin_event, peer_tenant, discord_id] = key.values();
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO event_participation_forwards \
               (origin_tenant_id, origin_event_id, peer_tenant_id, discord_id, peer_event_id, \
                username, from_tenant_id, operation, primary_build_id, secondary_build_id, \
                state, next_attempt_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending', NOW() + INTERVAL '15 seconds') \
             ON CONFLICT (origin_tenant_id, origin_event_id, peer_tenant_id, discord_id) \
             DO UPDATE SET peer_event_id=EXCLUDED.peer_event_id, username=EXCLUDED.username, \
               from_tenant_id=EXCLUDED.from_tenant_id, operation=EXCLUDED.operation, \
               primary_build_id=EXCLUDED.primary_build_id, \
               secondary_build_id=EXCLUDED.secondary_build_id, \
               state='pending', attempts=0, last_error=NULL, \
               revision=event_participation_forwards.revision + 1, \
               next_attempt_at=NOW() + INTERVAL '15 seconds', updated_at=NOW()",
            [
                origin_tenant,
                origin_event,
                peer_tenant,
                discord_id,
                peer_event_id.into(),
                username.to_owned().into(),
                from_tenant_id.to_owned().into(),
                intent.operation().into(),
                primary.into(),
                secondary.into(),
            ],
        ))
        .await?;
    Ok(())
}

/// Keys of entries due for another attempt, oldest first.
pub async fn due_keys(
    control: &DatabaseConnection,
    limit: i64,
) -> Result<Vec<ForwardKey>, AppError> {
    control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT origin_tenant_id, origin_event_id, peer_tenant_id, discord_id \
             FROM event_participation_forwards \
             WHERE state IN ('pending','failed') AND attempts < $1 AND next_attempt_at <= NOW() \
               AND (lease_until IS NULL OR lease_until <= NOW()) \
             ORDER BY next_attempt_at LIMIT $2",
            [MAX_ATTEMPTS.into(), limit.into()],
        ))
        .await?
        .into_iter()
        .map(|row| {
            Ok(ForwardKey {
                origin_tenant_id: row.try_get_by_index(0)?,
                origin_event_id: row.try_get_by_index(1)?,
                peer_tenant_id: row.try_get_by_index(2)?,
                discord_id: row.try_get_by_index(3)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(AppError::Database)
}

/// Leases the entry for delivery and returns its current (latest) intent.
///
/// `due_only` is the worker's claim; the fast path takes the entry whatever its schedule.
/// Either way an entry another delivery currently leases is not returned: the holder owns it,
/// and a newer intent recorded meanwhile is delivered once that lease ends.
pub async fn claim_entry(
    control: &DatabaseConnection,
    key: &ForwardKey,
    due_only: bool,
) -> Result<Option<PendingForward>, AppError> {
    let due = if due_only {
        "AND next_attempt_at <= NOW()"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE event_participation_forwards SET \
           lease_until=NOW() + ($6 * INTERVAL '1 second'), lease_token=$7, updated_at=NOW() \
         WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND peer_tenant_id=$3 \
           AND discord_id=$4 AND state IN ('pending','failed') AND attempts < $5 {due} \
           AND (lease_until IS NULL OR lease_until <= NOW()) \
         RETURNING peer_event_id, username, from_tenant_id, operation, primary_build_id, \
                   secondary_build_id, attempts, revision"
    );
    let lease_token = Uuid::new_v4();
    let [origin_tenant, origin_event, peer_tenant, discord_id] = key.values();
    let Some(row) = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [
                origin_tenant,
                origin_event,
                peer_tenant,
                discord_id,
                MAX_ATTEMPTS.into(),
                LEASE_SECONDS.into(),
                lease_token.into(),
            ],
        ))
        .await?
    else {
        return Ok(None);
    };
    let operation: String = row.try_get_by_index(3)?;
    let intent = if operation == "join" {
        Intent::Join {
            primary_build_id: row.try_get_by_index(4)?,
            secondary_build_id: row.try_get_by_index(5)?,
        }
    } else {
        Intent::Leave
    };
    Ok(Some(PendingForward {
        key: key.clone(),
        peer_event_id: row.try_get_by_index(0)?,
        username: row.try_get_by_index(1)?,
        from_tenant_id: row.try_get_by_index(2)?,
        intent,
        attempts: row.try_get_by_index(6)?,
        revision: row.try_get_by_index(7)?,
        lease_token,
    }))
}

/// The peer took the change: the entry is done, unless a newer intent replaced it while this
/// one was in flight (that one stays queued and only the lease is released).
pub async fn mark_delivered(
    control: &DatabaseConnection,
    entry: &PendingForward,
) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM event_participation_forwards \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND peer_tenant_id=$3 \
               AND discord_id=$4 AND revision=$5",
            entry.values_with_revision(),
        ))
        .await?;
    release_lease(control, entry).await
}

/// Drops an entry whose peer is no longer linked, whatever its revision.
pub async fn discard(control: &DatabaseConnection, key: &ForwardKey) -> Result<(), AppError> {
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM event_participation_forwards \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND peer_tenant_id=$3 \
               AND discord_id=$4",
            key.values(),
        ))
        .await?;
    Ok(())
}

/// Records a failed attempt: retry with backoff while attempts remain, else park the entry.
/// A newer intent recorded meanwhile keeps its own fresh schedule.
pub async fn mark_failed(
    control: &DatabaseConnection,
    entry: &PendingForward,
    error: &str,
    retry_delay_seconds: impl Fn(i32) -> i64,
) -> Result<FailureDisposition, AppError> {
    let attempts = entry.attempts + 1;
    let exhausted = attempts >= MAX_ATTEMPTS;
    let mut values = entry.values_with_revision().to_vec();
    values.extend([
        Value::from(if exhausted { "exhausted" } else { "failed" }),
        attempts.into(),
        error.to_owned().into(),
        retry_delay_seconds(attempts).max(1).into(),
    ]);
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE event_participation_forwards SET state=$6, attempts=$7, last_error=$8, \
               next_attempt_at=NOW() + ($9 * INTERVAL '1 second'), updated_at=NOW() \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND peer_tenant_id=$3 \
               AND discord_id=$4 AND revision=$5",
            values,
        ))
        .await?;
    release_lease(control, entry).await?;
    Ok(if exhausted {
        FailureDisposition::Exhausted
    } else {
        FailureDisposition::Retry
    })
}

async fn release_lease(
    control: &DatabaseConnection,
    entry: &PendingForward,
) -> Result<(), AppError> {
    let [origin_tenant, origin_event, peer_tenant, discord_id] = entry.key.values();
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE event_participation_forwards SET lease_until=NULL, lease_token=NULL \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND peer_tenant_id=$3 \
               AND discord_id=$4 AND lease_token=$5",
            [
                origin_tenant,
                origin_event,
                peer_tenant,
                discord_id,
                entry.lease_token.into(),
            ],
        ))
        .await?;
    Ok(())
}

/// Whether the outbox owns this participant's roster state for the origin event.
///
/// The roster sweep must not copy such a signup around: a leave that has not landed yet looks
/// exactly like a missing join. Only an exhausted *join* is released, since adding that signup
/// is the very outcome the entry was after.
pub async fn is_blocked(
    control: &DatabaseConnection,
    origin_tenant_id: &str,
    origin_event_id: i64,
    discord_id: &str,
) -> Result<bool, AppError> {
    Ok(control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM event_participation_forwards \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 AND discord_id=$3 \
               AND (state <> 'exhausted' OR operation = 'leave') LIMIT 1",
            [
                origin_tenant_id.into(),
                origin_event_id.into(),
                discord_id.into(),
            ],
        ))
        .await?
        .is_some())
}

/// Entries of an origin event.
#[cfg(test)]
pub async fn statuses(
    control: &DatabaseConnection,
    origin_tenant_id: &str,
    origin_event_id: i64,
) -> Result<Vec<ForwardStatus>, AppError> {
    control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT peer_tenant_id, discord_id, operation, state, attempts, last_error, \
                    next_attempt_at \
             FROM event_participation_forwards \
             WHERE origin_tenant_id=$1 AND origin_event_id=$2 \
             ORDER BY peer_tenant_id, discord_id",
            [origin_tenant_id.into(), origin_event_id.into()],
        ))
        .await?
        .into_iter()
        .map(|row| {
            Ok(ForwardStatus {
                peer_tenant_id: row.try_get_by_index(0)?,
                discord_id: row.try_get_by_index(1)?,
                operation: row.try_get_by_index(2)?,
                state: row.try_get_by_index(3)?,
                attempts: row.try_get_by_index(4)?,
                last_error: row.try_get_by_index(5)?,
                next_attempt_at: row.try_get_by_index(6)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(AppError::Database)
}
