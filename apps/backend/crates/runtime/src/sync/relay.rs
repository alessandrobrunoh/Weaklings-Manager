//! The relay: moves one tenant's unrelayed outbox rows into control jobs.
//!
//! Per tenant, in one transaction on the tenant database: select the due rows,
//! ask each handler for its targets, enqueue one job per target, then mark the
//! rows relayed. A crash before the final commit replays the rows; the jobs'
//! dedupe keys make the replay a no-op (R25).

use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, Statement,
    TransactionTrait,
};

use super::engine::SyncCx;
use super::failpoint;
use super::handler::{HandlerRegistry, OutboxRow};
use super::jobs::{self, Enqueued, NewJob, Params};
use super::policy;
use backend_core::errors::AppError;

/// Rows relayed per tenant per round.
pub const BATCH: i64 = 200;

/// What one relay pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RelayStats {
    /// Outbox rows marked relayed.
    pub rows: usize,
    /// Jobs newly inserted. A coalesced or duplicate target is not a new job.
    pub jobs: usize,
}

/// Relays the due outbox rows of `origin` (whose database is `db`).
///
/// # Errors
///
/// Database failures on the tenant or the control plane; the transaction is
/// rolled back and the rows stay unrelayed.
pub async fn relay_tenant(
    cx: &SyncCx,
    handlers: &HandlerRegistry,
    kinds: &[String],
    origin: &str,
    db: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<RelayStats, AppError> {
    if kinds.is_empty() {
        return Ok(RelayStats::default());
    }
    let txn = db.begin().await?;
    let rows = due_rows(&txn, kinds, now).await?;
    let mut relayed = Vec::with_capacity(rows.len());
    let mut stats = RelayStats::default();
    for row in rows {
        let Some(handler) = handlers.get(&row.kind) else {
            continue;
        };
        let plan = match handler.targets(cx, origin, &txn, &row).await {
            Ok(plan) => plan,
            Err(error) => {
                tracing::warn!(origin, outbox_id = row.id, kind = %row.kind, error = %error.message(), "sync targets failed; row stays unrelayed");
                mark_error(&txn, row.id, &error.message()).await?;
                continue;
            }
        };
        let targets = plan
            .desired
            .iter()
            .map(|target| (target, false))
            .chain(plan.retire.iter().map(|target| (target, true)));
        for (target, retire) in targets {
            let Some(job) = new_job(origin, &row, target, retire, handler.max_attempts()) else {
                continue;
            };
            match jobs::enqueue(&cx.control, &job, now).await? {
                Enqueued::Inserted => stats.jobs += 1,
                Enqueued::Coalesced | Enqueued::Duplicate => {}
            }
        }
        relayed.push(row.id);
    }
    failpoint::check("relay.after_jobs")?;
    for id in &relayed {
        txn.execute(Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE sync_outbox SET relayed_at = $1, relay_error = NULL WHERE id = $2",
            [now.into(), (*id).into()],
        ))
        .await?;
    }
    txn.commit().await?;
    stats.rows = relayed.len();
    Ok(stats)
}

async fn due_rows(
    txn: &DatabaseTransaction,
    kinds: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<OutboxRow>, AppError> {
    let backend = txn.get_database_backend();
    let mut params = Params::default();
    let now_ph = params.push(now);
    let kinds_ph = params.list(kinds);
    let limit = params.push(BATCH);
    let lock = if backend == DbBackend::Postgres {
        " FOR UPDATE SKIP LOCKED"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, kind, entity_id, op, command, ordering_key FROM sync_outbox \
         WHERE relayed_at IS NULL AND (not_before IS NULL OR not_before <= {now_ph}) \
           AND kind IN ({kinds_ph}) \
         ORDER BY id LIMIT {limit}{lock}"
    );
    let rows = txn
        .query_all(Statement::from_sql_and_values(backend, &sql, params.values))
        .await?;
    rows.iter()
        .map(|row| {
            Ok(OutboxRow {
                id: row.try_get_by_index(0)?,
                kind: row.try_get_by_index(1)?,
                entity_id: row.try_get_by_index(2)?,
                op: row.try_get_by_index(3)?,
                command: row.try_get_by_index::<Option<serde_json::Value>>(4)?,
                ordering_key: row.try_get_by_index(5)?,
            })
        })
        .collect()
}

async fn mark_error(txn: &DatabaseTransaction, id: i64, message: &str) -> Result<(), AppError> {
    txn.execute(Statement::from_sql_and_values(
        txn.get_database_backend(),
        "UPDATE sync_outbox SET relay_error = $1 WHERE id = $2",
        [message.to_owned().into(), id.into()],
    ))
    .await?;
    Ok(())
}

/// The job one target gets for one outbox row. `None` for an operation the
/// queue does not know.
fn new_job(
    origin: &str,
    row: &OutboxRow,
    target: &str,
    retire: bool,
    max_attempts: i32,
) -> Option<NewJob> {
    let (op, flow): (&'static str, &'static str) = if retire {
        ("delete", "to_copy")
    } else {
        match row.op.as_str() {
            "upsert" => ("upsert", "to_copy"),
            "delete" => ("delete", "to_copy"),
            "archive" => ("archive", "to_copy"),
            "command" => ("command", "to_origin"),
            _ => return None,
        }
    };
    let default_key = format!("{}:{origin}:{}:{target}", row.kind, row.entity_id);
    let ordering_key = match (&row.ordering_key, op) {
        (Some(key), "command") => key.clone(),
        _ => default_key,
    };
    Some(NewJob {
        kind: row.kind.clone(),
        op,
        flow,
        origin_tenant_id: origin.to_owned(),
        origin_id: row.entity_id,
        target_tenant_id: target.to_owned(),
        subject: String::new(),
        origin_version: row.id,
        ordering_key,
        dedupe_key: format!("{origin}:{}:{target}:{}", row.id, row.kind),
        payload: row.command.clone().unwrap_or_else(|| serde_json::json!({})),
        priority: policy::priority_for(op),
        max_attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retire_jobs_are_deletes_and_commands_flow_to_the_origin() {
        let row = OutboxRow {
            id: 7,
            kind: "event".into(),
            entity_id: 42,
            op: "upsert".into(),
            command: None,
            ordering_key: None,
        };
        let desired = new_job("A", &row, "G1", false, 12).expect("upsert");
        assert_eq!((desired.op, desired.flow), ("upsert", "to_copy"));
        assert_eq!(desired.ordering_key, "event:A:42:G1");
        assert_eq!(desired.dedupe_key, "A:7:G1:event");
        let retired = new_job("A", &row, "G2", true, 12).expect("retire");
        assert_eq!(retired.op, "delete");

        let command = OutboxRow {
            op: "command".into(),
            command: Some(serde_json::json!({"discord_id": "1"})),
            ordering_key: Some("cmd:A:42:1".into()),
            ..row
        };
        let job = new_job("G1", &command, "A", false, 8).expect("command");
        assert_eq!((job.op, job.flow), ("command", "to_origin"));
        assert_eq!(job.ordering_key, "cmd:A:42:1");
        assert_eq!(job.priority, policy::priority_for("command"));

        let unknown = OutboxRow {
            op: "explode".into(),
            ..command
        };
        assert!(new_job("G1", &unknown, "A", false, 8).is_none());
    }
}
