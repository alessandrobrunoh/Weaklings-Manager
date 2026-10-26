//! Migration script adding the `event_kind` discriminant to the `events` table.

use sea_orm_migration::prelude::*;

/// Adds `event_kind` (`organized` | `flash`) and makes `comp_id` nullable so
/// flash masses can exist without a composition.
///
/// Flash masses are identified ONLY by `event_kind`; a NULL `comp_id` is a
/// consequence of that flag, never the discriminant itself. Existing rows
/// backfill to `organized` and keep their comp, so every pre-migration code
/// path observes the same data it saw before.
///
/// SQLite cannot `ALTER COLUMN`, so there the table is rebuilt with the same
/// shape (the pattern `m20260901_000009` used for participations). Production
/// runs Postgres and takes the plain `DROP NOT NULL` path.
///
/// `down()` refuses: restoring NOT NULL would fail while flash rows exist.
/// After flash events are in production, roll forward, not back.
#[derive(DeriveMigrationName)]
pub struct Migration;

const EVENTS_COLUMNS: &str = "id, title, description, call_to_arms, regear, \
     event_kind, comp_id, player_cap, created_by, event_date_utc, mass_time_utc, \
     start_time_utc, created_at, updated_at, status, started_at, stopped_at, \
     auto_stop_deadline, link_status, link_attempts, link_last_error, \
     link_battles_completed_at, discord_voice_channel_id, roster_version, \
     archived_at, ping_alliance, alliance_discord_message_id";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Sqlite {
            let db = manager.get_connection();
            db.execute_unprepared(
                "CREATE TABLE events_kind_tmp (\
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \
                    title TEXT NOT NULL, \
                    description TEXT, \
                    call_to_arms BOOLEAN NOT NULL DEFAULT 0, \
                    regear BOOLEAN NOT NULL DEFAULT 0, \
                    event_kind TEXT NOT NULL DEFAULT 'organized', \
                    comp_id BIGINT, \
                    player_cap BIGINT, \
                    created_by BIGINT NOT NULL, \
                    event_date_utc TEXT NOT NULL, \
                    mass_time_utc TEXT, \
                    start_time_utc TEXT, \
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    status TEXT NOT NULL DEFAULT 'scheduled', \
                    started_at TEXT, \
                    stopped_at TEXT, \
                    auto_stop_deadline TEXT, \
                    link_status TEXT NOT NULL DEFAULT 'pending', \
                    link_attempts BIGINT NOT NULL DEFAULT 0, \
                    link_last_error TEXT, \
                    link_battles_completed_at TEXT, \
                    discord_voice_channel_id TEXT, \
                    roster_version BIGINT NOT NULL DEFAULT 0, \
                    archived_at TEXT, \
                    ping_alliance BOOLEAN NOT NULL DEFAULT 0, \
                    alliance_discord_message_id TEXT, \
                    FOREIGN KEY (comp_id) REFERENCES comps(id) ON DELETE RESTRICT, \
                    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT\
                )",
            )
            .await?;
            db.execute_unprepared(&format!(
                "INSERT INTO events_kind_tmp ({EVENTS_COLUMNS}) \
                 SELECT id, title, description, call_to_arms, regear, 'organized', \
                 comp_id, player_cap, created_by, event_date_utc, mass_time_utc, \
                 start_time_utc, created_at, updated_at, status, started_at, \
                 stopped_at, auto_stop_deadline, link_status, link_attempts, \
                 link_last_error, link_battles_completed_at, discord_voice_channel_id, \
                 roster_version, archived_at, ping_alliance, alliance_discord_message_id \
                 FROM events"
            ))
            .await?;
            db.execute_unprepared("DROP TABLE events").await?;
            db.execute_unprepared("ALTER TABLE events_kind_tmp RENAME TO events")
                .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_events_event_date_utc ON events(event_date_utc)",
            )
            .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_events_session_status ON events(status, started_at)",
            )
            .await?;
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .add_column(
                        ColumnDef::new(Alias::new("event_kind"))
                            .string()
                            .not_null()
                            .default("organized"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    // `.null()` is what emits `DROP NOT NULL`; without it
                    // sea-query keeps the original NOT NULL constraint (see
                    // the Fill-participations postmortem in
                    // m20260902_000009).
                    .modify_column(
                        ColumnDef::new(Alias::new("comp_id"))
                            .big_integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "cannot restore NOT NULL on events.comp_id while flash masses exist; roll forward instead"
                .to_string(),
        ))
    }
}
