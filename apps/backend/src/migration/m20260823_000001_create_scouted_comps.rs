//! Creates the scouted enemy composition tables.
//!
//! A scouted comp is what Intel learns about an enemy guild by watching the
//! battles we fought against them: how many players, in what roles, carrying
//! which weapons. Scouts are merged across battles rather than duplicated, so
//! the picture of a given opponent sharpens over time.
//!
//! Two tables rather than one:
//! - the histograms (`roles_json`, `weapons_json`, `players_json`) are always
//!   read as a whole — similarity needs the complete vector and a merge
//!   replaces the roster wholesale — and nothing ever filters on an individual
//!   weapon in SQL, so normalizing them would buy joins and no query power;
//! - `source_battle_ids` is the opposite case. It drives the matchup tally, so
//!   it lives in a real child table with an index instead of a JSON array that
//!   would force a full scan on every matchup request.
//!
//! JSON columns are `text`, not `json`/`jsonb`: the crate builds against both
//! `sqlx-postgres` and `sqlx-sqlite` and the test suite runs on in-memory
//! SQLite, exactly as `m20260811_000005_create_guild_battle_snapshots` does.

use sea_orm_migration::prelude::*;

/// Migration step for the Intel scouted-composition tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ScoutedComps::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ScoutedComps::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ScoutedComps::Name).string_len(160).not_null())
                    .col(ColumnDef::new(ScoutedComps::OpponentGuildId).string_len(64))
                    .col(
                        ColumnDef::new(ScoutedComps::OpponentGuildName)
                            .string_len(160)
                            .not_null(),
                    )
                    .col(ColumnDef::new(ScoutedComps::OpponentAllianceName).string_len(160))
                    .col(
                        ColumnDef::new(ScoutedComps::Category)
                            .string_len(16)
                            .not_null()
                            .default("small_scale"),
                    )
                    .col(
                        ColumnDef::new(ScoutedComps::PlayerCount)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // How many of `player_count` players actually contributed a
                    // weapon. The kill feed only names players who killed or
                    // died, so this is routinely lower and callers must show
                    // similarity confidence accordingly.
                    .col(
                        ColumnDef::new(ScoutedComps::WeaponSampleSize)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ScoutedComps::AvgIp)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(ColumnDef::new(ScoutedComps::RolesJson).text().not_null())
                    .col(ColumnDef::new(ScoutedComps::WeaponsJson).text().not_null())
                    .col(ColumnDef::new(ScoutedComps::PlayersJson).text().not_null())
                    .col(
                        ColumnDef::new(ScoutedComps::Fingerprint)
                            .string_len(512)
                            .not_null(),
                    )
                    // Denormalized count of child rows, so listing can sort by
                    // "most observed" without a join.
                    .col(
                        ColumnDef::new(ScoutedComps::SourceBattleCount)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // Denormalized `losses * 2 + player_count`, recomputed on merge.
                    .col(
                        ColumnDef::new(ScoutedComps::ThreatScore)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(ScoutedComps::Notes).text())
                    // Soft delete: archiving hides a scout from the board while
                    // keeping its battles, and therefore its matchup history.
                    .col(
                        ColumnDef::new(ScoutedComps::IsArchived)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(ScoutedComps::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ScoutedComps::SavedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    // NULL means the background worker scouted it, not a person.
                    .col(ColumnDef::new(ScoutedComps::CreatedByUserId).big_integer())
                    .col(
                        ColumnDef::new(ScoutedComps::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ScoutedComps::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_scouted_comps_created_by")
                            .from(ScoutedComps::Table, ScoutedComps::CreatedByUserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comps_fingerprint")
                    .table(ScoutedComps::Table)
                    .col(ScoutedComps::Fingerprint)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comps_guild_category")
                    .table(ScoutedComps::Table)
                    .col(ScoutedComps::OpponentGuildId)
                    .col(ScoutedComps::Category)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comps_saved_at")
                    .table(ScoutedComps::Table)
                    .col(ScoutedComps::SavedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ScoutedCompBattles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ScoutedCompBattles::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ScoutedCompBattles::ScoutedCompId)
                            .big_integer()
                            .not_null(),
                    )
                    // Canonical AlbionBB battle id, matching
                    // `guild_battle_snapshots.battle_id`. Note that
                    // `event_battles.albionbb_battle_id` stores the same value
                    // as a *string*: join across the two in Rust by converting
                    // ids to strings, never with a SQL cast, which would be
                    // Postgres-only and break the SQLite test backend.
                    //
                    // Intentionally no foreign key to either table: snapshots
                    // may be pruned and event battles cascade away with their
                    // event, but scouting history must survive both.
                    .col(
                        ColumnDef::new(ScoutedCompBattles::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ScoutedCompBattles::LinkedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_scouted_comp_battles_scout")
                            .from(
                                ScoutedCompBattles::Table,
                                ScoutedCompBattles::ScoutedCompId,
                            )
                            .to(ScoutedComps::Table, ScoutedComps::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Makes re-scouting the same battle idempotent.
        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comp_battles_unique")
                    .table(ScoutedCompBattles::Table)
                    .col(ScoutedCompBattles::ScoutedCompId)
                    .col(ScoutedCompBattles::BattleId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // Answers "has this battle already been scouted?" with one indexed hit,
        // which is why no `processed` flag is needed on the snapshot table.
        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comp_battles_battle")
                    .table(ScoutedCompBattles::Table)
                    .col(ScoutedCompBattles::BattleId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ScoutedCompBattles::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ScoutedComps::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum ScoutedComps {
    Table,
    Id,
    Name,
    OpponentGuildId,
    OpponentGuildName,
    OpponentAllianceName,
    Category,
    PlayerCount,
    WeaponSampleSize,
    AvgIp,
    RolesJson,
    WeaponsJson,
    PlayersJson,
    Fingerprint,
    SourceBattleCount,
    ThreatScore,
    Notes,
    IsArchived,
    FirstSeenAt,
    SavedAt,
    CreatedByUserId,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
pub enum ScoutedCompBattles {
    Table,
    Id,
    ScoutedCompId,
    BattleId,
    LinkedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
