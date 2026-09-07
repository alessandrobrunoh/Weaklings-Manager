//! Widens `regear_deaths` to also hold member-initiated ("self-reported") requests, not just
//! deaths the kill-feed extractor discovered.
//!
//! `event_battle_id`, `albionbb_battle_id`, and `albion_kill_event_id` become nullable: a
//! self-reported request has no battle/kill-feed origin. `source` discriminates the two origins
//! (`extracted` / `self_reported`); `override_loadout_json` holds the final (possibly
//! slot-edited) loadout actually priced, while `loadout_json` keeps meaning "the loadout shown
//! at request time" for both origins. `killed_at`/`guild_id`/`player_name` stay `NOT NULL` — a
//! self-reported row stores the submission time and the caller's linked Albion name there, so no
//! wider blast radius (e.g. widening `killed_at` to nullable) is needed.
//!
//! Postgres NULLs are distinct in a unique index, so self-reported rows (all with
//! `event_battle_id = NULL`) never collide with each other or with extracted rows on
//! `idx_regear_deaths_unique` — duplicate self-reports are prevented at the application layer
//! instead (see `RegearService::create_self_service_request`).
//!
//! SQLite has no `ALTER COLUMN`, so relaxing an existing `NOT NULL` requires rebuilding the
//! table — the same technique `m20260901_000009_allow_fill_event_participations` used.

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

/// Migration step adding self-reported regear request support.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        if manager.get_database_backend() == DatabaseBackend::Sqlite {
            // `auto_estimate_total`/`final_amount` are declared `real(16, 0)`, matching the exact
            // declared-type text `decimal_len(16, 0)` emits for SQLite in the original migration
            // (verified by inspecting `sqlite_master`). sqlx's rust_decimal codec for SQLite reads
            // the column's declared type to pick its decode path; a plain `NUMERIC` declaration
            // gives SQLite the same *affinity* but decodes as an integer storage class once the
            // stored value has no fractional part, which sqlx's decimal reader rejects as a type
            // mismatch. Declaring it identically to the original avoids that trap entirely.
            db.execute_unprepared(
                "CREATE TABLE regear_deaths_tmp (\
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \
                    event_id INTEGER NOT NULL, \
                    event_battle_id INTEGER, \
                    albionbb_battle_id TEXT, \
                    albion_kill_event_id TEXT, \
                    killed_at TEXT NOT NULL, \
                    user_id INTEGER, \
                    player_name TEXT NOT NULL, \
                    guild_id TEXT NOT NULL, \
                    primary_build_id INTEGER, \
                    loadout_json TEXT NOT NULL, \
                    auto_estimate_total real(16, 0) NOT NULL DEFAULT 0, \
                    auto_estimate_breakdown_json TEXT NOT NULL DEFAULT '[]', \
                    status TEXT NOT NULL DEFAULT 'available', \
                    requested_at TEXT, \
                    decided_at TEXT, \
                    decided_by_user_id INTEGER, \
                    final_amount real(16, 0), \
                    final_breakdown_json TEXT, \
                    officer_note TEXT, \
                    bank_transaction_id INTEGER, \
                    source TEXT NOT NULL DEFAULT 'extracted', \
                    override_loadout_json TEXT, \
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
                )",
            )
            .await?;
            db.execute_unprepared(
                "INSERT INTO regear_deaths_tmp (\
                    id, event_id, event_battle_id, albionbb_battle_id, albion_kill_event_id, \
                    killed_at, user_id, player_name, guild_id, primary_build_id, loadout_json, \
                    auto_estimate_total, auto_estimate_breakdown_json, status, requested_at, \
                    decided_at, decided_by_user_id, final_amount, final_breakdown_json, \
                    officer_note, bank_transaction_id, created_at, updated_at\
                ) SELECT \
                    id, event_id, event_battle_id, albionbb_battle_id, albion_kill_event_id, \
                    killed_at, user_id, player_name, guild_id, primary_build_id, loadout_json, \
                    auto_estimate_total, auto_estimate_breakdown_json, status, requested_at, \
                    decided_at, decided_by_user_id, final_amount, final_breakdown_json, \
                    officer_note, bank_transaction_id, created_at, updated_at \
                FROM regear_deaths",
            )
            .await?;
            db.execute_unprepared("DROP TABLE regear_deaths").await?;
            db.execute_unprepared("ALTER TABLE regear_deaths_tmp RENAME TO regear_deaths")
                .await?;
            db.execute_unprepared(
                "CREATE UNIQUE INDEX idx_regear_deaths_unique ON regear_deaths \
                 (event_battle_id, albion_kill_event_id, player_name)",
            )
            .await?;
            db.execute_unprepared("CREATE INDEX idx_regear_deaths_user ON regear_deaths (user_id)")
                .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_regear_deaths_status ON regear_deaths (status)",
            )
            .await?;
            db.execute_unprepared(
                "CREATE INDEX idx_regear_deaths_event ON regear_deaths (event_id)",
            )
            .await?;
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(RegearDeaths::Table)
                    .modify_column(
                        ColumnDef::new(RegearDeaths::EventBattleId)
                            .big_integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearDeaths::Table)
                    .modify_column(
                        ColumnDef::new(RegearDeaths::AlbionbbBattleId)
                            .string_len(64)
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearDeaths::Table)
                    .modify_column(
                        ColumnDef::new(RegearDeaths::AlbionKillEventId)
                            .string_len(64)
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearDeaths::Table)
                    .add_column(
                        ColumnDef::new(RegearDeaths::Source)
                            .string_len(16)
                            .not_null()
                            .default("extracted"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearDeaths::Table)
                    .add_column(ColumnDef::new(RegearDeaths::OverrideLoadoutJson).text())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "cannot restore NOT NULL on regear_deaths battle columns while self-reported \
             requests exist"
                .to_string(),
        ))
    }
}

#[derive(DeriveIden)]
enum RegearDeaths {
    Table,
    EventBattleId,
    AlbionbbBattleId,
    AlbionKillEventId,
    Source,
    OverrideLoadoutJson,
}
