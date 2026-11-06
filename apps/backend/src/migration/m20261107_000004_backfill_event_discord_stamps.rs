//! Backfills the Discord stamps of events that are already past their mass or reminder time,
//! and creates the scheduler index (DO-S1, R22).

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use sea_orm_migration::prelude::*;

/// Non-terminal events whose mass or one-hour reminder time has already passed get the stamp
/// set now, so the scheduler does not re-announce them at cutover (the importer file may be
/// missing). Terminal events are never stamped: the scheduler ignores them.
///
/// `ix_events_sched` serves the scheduler's due-scan over non-archived scheduled and live events.
#[derive(DeriveMigrationName)]
pub struct Migration;

fn backfill_statements(backend: DbBackend) -> [String; 3] {
    // SQLite keeps timestamps as text: `datetime()` normalises both the stored and the
    // compared values to `YYYY-MM-DD HH:MM:SS`. PostgreSQL uses native timestamptz arithmetic.
    let (mass, reminder) = match backend {
        DbBackend::Sqlite => (
            "UPDATE events SET mass_notified_at = datetime('now') \
             WHERE mass_notified_at IS NULL AND status IN ('scheduled', 'live') \
             AND mass_time_utc IS NOT NULL AND datetime(mass_time_utc) <= datetime('now')",
            "UPDATE events SET reminder_notified_at = datetime('now') \
             WHERE reminder_notified_at IS NULL AND status IN ('scheduled', 'live') \
             AND start_time_utc IS NOT NULL AND datetime(start_time_utc, '-1 hour') <= datetime('now')",
        ),
        _ => (
            "UPDATE events SET mass_notified_at = now() \
             WHERE mass_notified_at IS NULL AND status IN ('scheduled', 'live') \
             AND mass_time_utc IS NOT NULL AND mass_time_utc <= now()",
            "UPDATE events SET reminder_notified_at = now() \
             WHERE reminder_notified_at IS NULL AND status IN ('scheduled', 'live') \
             AND start_time_utc IS NOT NULL AND start_time_utc - INTERVAL '1 hour' <= now()",
        ),
    };
    [
        mass.to_owned(),
        reminder.to_owned(),
        "CREATE INDEX ix_events_sched ON events (status, start_time_utc) \
         WHERE archived_at IS NULL AND status IN ('scheduled', 'live')"
            .to_owned(),
    ]
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for sql in backfill_statements(db.get_database_backend()) {
            db.execute(Statement::from_string(db.get_database_backend(), sql))
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS ix_events_sched")
            .await?;
        Ok(())
    }
}
