//! Writes the tenant outbox row inside the caller's domain transaction.
//!
//! Every mutating path that changes synchronized state calls [`emit`] in the
//! same transaction as the change, so a crash never leaves a change without
//! its outbox row (the relay picks the row up later).

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, Statement, Value};

use crate::errors::AppError;

/// What happened to the entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOp {
    /// Make the copies equal the origin now.
    Upsert,
    /// The copies must drop the entity.
    Delete,
    /// The copies must keep the entity read-only and archived.
    Archive,
    /// A command for the origin (never coalesced).
    Command,
}

impl SyncOp {
    /// Column value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::Delete => "delete",
            Self::Archive => "archive",
            Self::Command => "command",
        }
    }

    /// State operations describe the entity; they coalesce and are ignored on copies.
    #[must_use]
    pub fn is_state(self) -> bool {
        !matches!(self, Self::Command)
    }
}

/// One change to publish.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncEmit {
    /// Sync kind.
    pub kind: String,
    /// Entity id in the emitting tenant.
    pub entity_id: i64,
    /// Operation.
    pub op: SyncOp,
    /// Command body (commands only).
    pub command: Option<serde_json::Value>,
    /// Ordering key (commands only; relay derives one for state rows).
    pub ordering_key: Option<String>,
    /// Earliest relay time (debounce).
    pub not_before: Option<DateTime<Utc>>,
}

impl SyncEmit {
    /// A state change of `kind`/`entity_id`.
    #[must_use]
    pub fn state(kind: impl Into<String>, entity_id: i64, op: SyncOp) -> Self {
        Self {
            kind: kind.into(),
            entity_id,
            op,
            command: None,
            ordering_key: None,
            not_before: None,
        }
    }
}

/// Appends the outbox row for `ev` on the caller's connection (normally a
/// transaction). Returns the outbox id (the job's `origin_version`), or `None`
/// when the entity is a read-only copy and the change is a state change: copies
/// never originate state.
///
/// A state row replaces the older unrelayed state rows of the same entity, so
/// a burst of edits relays once with the last version.
///
/// # Errors
///
/// Database failures.
pub async fn emit(db: &impl ConnectionTrait, ev: SyncEmit) -> Result<Option<i64>, AppError> {
    let backend = db.get_database_backend();
    if ev.op.is_state() {
        if is_read_only_copy(db, &ev.kind, ev.entity_id).await? {
            tracing::debug!(kind = %ev.kind, entity_id = ev.entity_id, "state emit on a copy skipped");
            return Ok(None);
        }
        db.execute(Statement::from_sql_and_values(
            backend,
            "DELETE FROM sync_outbox \
             WHERE kind = $1 AND entity_id = $2 AND relayed_at IS NULL AND op <> 'command'",
            [ev.kind.clone().into(), ev.entity_id.into()],
        ))
        .await?;
    }
    let command = ev
        .command
        .map_or(Value::Json(None), |body| Value::Json(Some(Box::new(body))));
    let row = db
        .query_one(Statement::from_sql_and_values(
            backend,
            "INSERT INTO sync_outbox (kind, entity_id, op, command, ordering_key, not_before) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [
                ev.kind.clone().into(),
                ev.entity_id.into(),
                ev.op.as_str().into(),
                command,
                ev.ordering_key.into(),
                ev.not_before.into(),
            ],
        ))
        .await?
        .ok_or_else(|| AppError::Internal("sync_outbox insert returned no id".to_owned()))?;
    Ok(Some(row.try_get_by_index::<i64>(0)?))
}

/// Whether `sync_copies` marks the entity as an active read-only copy.
///
/// # Errors
///
/// Database failures.
pub async fn is_read_only_copy(
    db: &impl ConnectionTrait,
    kind: &str,
    entity_id: i64,
) -> Result<bool, AppError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            db.get_database_backend(),
            "SELECT 1 FROM sync_copies \
             WHERE kind = $1 AND local_id = $2 AND read_only = $3 AND state = 'active'",
            [kind.into(), entity_id.into(), true.into()],
        ))
        .await?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_commands_skip_coalescing_and_copy_checks() {
        assert!(SyncOp::Upsert.is_state());
        assert!(SyncOp::Delete.is_state());
        assert!(SyncOp::Archive.is_state());
        assert!(!SyncOp::Command.is_state());
        assert_eq!(SyncOp::Command.as_str(), "command");
    }
}
