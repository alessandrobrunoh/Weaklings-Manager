//! Creates the SQL-queryable battle evidence tables: `battle_guild_stats`,
//! `battle_player_stats`, `battle_kills` and `battle_kill_items`.
//!
//! Today everything hydrated from `AlbionBB` for a battle — the per-guild
//! tallies, the per-player stat line, the kill feed, even the victim's
//! equipment at time of death — lives nested inside the JSON blobs on
//! `guild_battle_snapshots` (`guilds_json`, `players_json`, `kills_json`,
//! `losses_json`). That is fine for re-rendering a battle page, but it means
//! nothing about a specific player, guild or kill can be filtered, joined or
//! aggregated in SQL: answering "how many kills has this guild landed on us
//! this month" or "what does this player's build look like across battles"
//! means loading every snapshot row and parsing JSON in application code.
//!
//! These four tables give that data real columns and indexes, hydrated
//! alongside (not instead of) the existing snapshot blobs — this migration is
//! purely additive and does not touch `guild_battle_snapshots` or backfill
//! anything into these tables.
//!
//! `battle_guild_stats` and `battle_player_stats` key off the plain,
//! unconstrained `AlbionBB` `battle_id`, the same idiom already used by
//! `scouted_comp_battles.battle_id` and `fight_battles.battle_id`: no foreign
//! key to `guild_battle_snapshots`, so this evidence survives snapshot
//! pruning. Player identity upstream is unreliable — the battle-detail player
//! list frequently omits `id` — so `battle_player_stats.player_key` is an
//! opaque fallback key the caller computes (by id when present, by lowercased
//! name otherwise), not something derived here.
//!
//! `battle_kills` is keyed by `source_event_id`, the `AlbionBB` kill event id,
//! which is globally unique across the whole game rather than scoped to one
//! battle. That is what will let a kill observed in two overlapping battle
//! segments be deduplicated later; `battle_id` on this table only records
//! which battle *this hydration run* attributed the kill to.
//!
//! `battle_kill_items` is the one table with a real foreign key
//! (`kill_id` -> `battle_kills.id`, cascading), because `battle_kills` is a
//! table we own, not an upstream identifier.

use sea_orm_migration::prelude::*;

/// Migration step creating the battle evidence tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[allow(clippy::too_many_lines)]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BattleGuildStats::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattleGuildStats::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::GuildId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::GuildName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattleGuildStats::AllianceId).string())
                    .col(ColumnDef::new(BattleGuildStats::AllianceName).string())
                    .col(
                        ColumnDef::new(BattleGuildStats::IsFriendly)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::Players)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::Kills)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::Deaths)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::KillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::AvgItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::Winner)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(BattleGuildStats::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_guild_stats_battle_id")
                    .table(BattleGuildStats::Table)
                    .col(BattleGuildStats::BattleId)
                    .to_owned(),
            )
            .await?;

        // `guild_id` can be empty on messy upstream payloads, and it can be
        // empty for more than one guild in the same battle; folding
        // `guild_name` into the unique key keeps that rare case from
        // colliding instead of erroring.
        manager
            .create_index(
                Index::create()
                    .name("idx_battle_guild_stats_battle_guild_unique")
                    .table(BattleGuildStats::Table)
                    .col(BattleGuildStats::BattleId)
                    .col(BattleGuildStats::GuildId)
                    .col(BattleGuildStats::GuildName)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BattlePlayerStats::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattlePlayerStats::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::PlayerKey)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattlePlayerStats::PlayerId).string())
                    .col(
                        ColumnDef::new(BattlePlayerStats::PlayerName)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::IdentitySource)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::GuildId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::GuildName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattlePlayerStats::AllianceName).string())
                    .col(
                        ColumnDef::new(BattlePlayerStats::IsFriendly)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::Kills)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::Deaths)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::KillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::DeathFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattlePlayerStats::ItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(ColumnDef::new(BattlePlayerStats::MainHandItemId).string())
                    .col(ColumnDef::new(BattlePlayerStats::Role).string())
                    .col(ColumnDef::new(BattlePlayerStats::RoleConfidence).string())
                    .col(
                        ColumnDef::new(BattlePlayerStats::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_player_stats_battle_id")
                    .table(BattlePlayerStats::Table)
                    .col(BattlePlayerStats::BattleId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_player_stats_battle_player_unique")
                    .table(BattlePlayerStats::Table)
                    .col(BattlePlayerStats::BattleId)
                    .col(BattlePlayerStats::PlayerKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BattleKills::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattleKills::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattleKills::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleKills::SourceEventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleKills::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleKills::KillerPlayerKey)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattleKills::KillerName).string().not_null())
                    .col(ColumnDef::new(BattleKills::KillerGuildId).string())
                    .col(ColumnDef::new(BattleKills::KillerGuildName).string())
                    .col(
                        ColumnDef::new(BattleKills::VictimPlayerKey)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattleKills::VictimName).string().not_null())
                    .col(ColumnDef::new(BattleKills::VictimGuildId).string())
                    .col(ColumnDef::new(BattleKills::VictimGuildName).string())
                    .col(
                        ColumnDef::new(BattleKills::KillerItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(BattleKills::VictimItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(BattleKills::TotalKillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleKills::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_kills_battle_id")
                    .table(BattleKills::Table)
                    .col(BattleKills::BattleId)
                    .to_owned(),
            )
            .await?;

        // Globally unique, not scoped to `battle_id`: the same AlbionBB kill
        // event id must never be recorded twice, even if it were attributed
        // to two overlapping battle segments.
        manager
            .create_index(
                Index::create()
                    .name("idx_battle_kills_source_event_unique")
                    .table(BattleKills::Table)
                    .col(BattleKills::SourceEventId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BattleKillItems::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattleKillItems::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattleKillItems::KillId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BattleKillItems::Slot).string().not_null())
                    .col(
                        ColumnDef::new(BattleKillItems::ItemTypeId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleKillItems::Quantity)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(BattleKillItems::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_battle_kill_items_kill_id")
                            .from(BattleKillItems::Table, BattleKillItems::KillId)
                            .to(BattleKills::Table, BattleKills::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_kill_items_kill_id")
                    .table(BattleKillItems::Table)
                    .col(BattleKillItems::KillId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BattleKillItems::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(BattleKills::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(BattlePlayerStats::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(BattleGuildStats::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum BattleGuildStats {
    Table,
    Id,
    BattleId,
    GuildId,
    GuildName,
    AllianceId,
    AllianceName,
    IsFriendly,
    Players,
    Kills,
    Deaths,
    KillFame,
    AvgItemPower,
    Winner,
    CreatedAt,
}

#[derive(DeriveIden)]
enum BattlePlayerStats {
    Table,
    Id,
    BattleId,
    PlayerKey,
    PlayerId,
    PlayerName,
    IdentitySource,
    GuildId,
    GuildName,
    AllianceName,
    IsFriendly,
    Kills,
    Deaths,
    KillFame,
    DeathFame,
    ItemPower,
    MainHandItemId,
    Role,
    RoleConfidence,
    CreatedAt,
}

#[derive(DeriveIden)]
enum BattleKills {
    Table,
    Id,
    BattleId,
    SourceEventId,
    OccurredAt,
    KillerPlayerKey,
    KillerName,
    KillerGuildId,
    KillerGuildName,
    VictimPlayerKey,
    VictimName,
    VictimGuildId,
    VictimGuildName,
    KillerItemPower,
    VictimItemPower,
    TotalKillFame,
    CreatedAt,
}

#[derive(DeriveIden)]
enum BattleKillItems {
    Table,
    Id,
    KillId,
    Slot,
    ItemTypeId,
    Quantity,
    CreatedAt,
}
