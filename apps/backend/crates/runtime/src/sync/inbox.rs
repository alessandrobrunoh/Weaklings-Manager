//! Origin-side command ordering (R26).
//!
//! Commands carry `(issued_at, seq)` from their emitter. The origin applies a
//! command only when that pair is newer than the last one applied for the same
//! ordering key, so two emitters racing on one entity cannot resurrect an old
//! command. `origin_version` is never compared across emitters.

#![allow(
    dead_code,
    reason = "consumed by the command handlers (participation commands, SY-4b)"
)]

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, Statement};

use backend_core::errors::AppError;

/// Admits a command with `(issued_at, seq)` for `ordering_key`.
///
/// Returns `true` when it is newer than the last admitted one (and records it),
/// `false` when it is stale and must be answered `superseded`.
///
/// # Errors
///
/// Database failures.
pub async fn admit(
    db: &impl ConnectionTrait,
    ordering_key: &str,
    issued_at: DateTime<Utc>,
    seq: i64,
) -> Result<bool, AppError> {
    let backend = db.get_database_backend();
    let inserted = db
        .execute(Statement::from_sql_and_values(
            backend,
            "INSERT INTO sync_inbox (ordering_key, last_issued_at, last_seq) \
             VALUES ($1, $2, $3) ON CONFLICT (ordering_key) DO NOTHING",
            [ordering_key.into(), issued_at.into(), seq.into()],
        ))
        .await?;
    if inserted.rows_affected() == 1 {
        return Ok(true);
    }
    // Conditional update: the comparison and the write are one statement, so a
    // concurrent admit cannot slip an older pair in between.
    let updated = db
        .execute(Statement::from_sql_and_values(
            backend,
            "UPDATE sync_inbox SET last_issued_at = $1, last_seq = $2 \
             WHERE ordering_key = $3 \
               AND (last_issued_at < $1 OR (last_issued_at = $1 AND last_seq < $2))",
            [issued_at.into(), seq.into(), ordering_key.into()],
        ))
        .await?;
    Ok(updated.rows_affected() == 1)
}
