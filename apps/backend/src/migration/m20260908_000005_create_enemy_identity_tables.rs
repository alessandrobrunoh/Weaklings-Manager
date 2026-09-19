//! Creates the enemy identity tables: `enemy_guilds`, `enemy_guild_aliases`,
//! `enemy_players` and `enemy_player_battles`.
//!
//! Today an opponent only exists as denormalized strings on a
//! `scouted_comps` row — one scouted *composition*, not a gilda or a player.
//! There is no way to answer "which guilds have we fought", "who is this
//! player", or "what has this player done to us" as a query. This migration
//! builds that identity layer on top of the normalized evidence
//! `battle_guild_stats`/`battle_player_stats`/`battle_kills` already provide
//! (see `m20260908_000004_create_battle_evidence_tables`).
//!
//! **Identity vs. rollup — the one rule this schema depends on.**
//! `enemy_guilds` and `enemy_players` are the canonical, officer-correctable
//! identity rows: a name, a watchlist flag, notes an officer can edit later.
//! They deliberately carry **no** derived numbers — no `battles_seen`, no
//! `kills_traded`, no running tally of any kind. `enemy_player_battles` is
//! the append-only bridge from one enemy player to one battle they were
//! observed in, and it is the *only* source every rollup (battles fought,
//! kills traded, builds observed, item power over time) is computed from, at
//! read time, by aggregating this table.
//!
//! This split is not cosmetic. Battle hydration is re-run: a battle can be
//! re-fetched and its evidence rows replaced (that is exactly why
//! `enemy_player_battles` carries a unique `(battle_id, enemy_player_id)`
//! index — so a caller can safely upsert/replace one battle's rows without
//! duplicating them). If `enemy_guilds` or `enemy_players` carried a
//! `battles_seen` counter incremented on ingestion, replaying or re-hydrating
//! a battle would double-count it, and there would be no way to tell a
//! correct total from an inflated one short of recomputing from scratch
//! anyway. Keeping the identity tables free of rollups means there is never
//! a second, drifting copy of a number that `enemy_player_battles` already
//! answers authoritatively — a future reader must not "helpfully" add a
//! counter column to `enemy_guilds`/`enemy_players` without understanding
//! that this would immediately reintroduce that bug.
//!
//! `enemy_guild_aliases` exists so a guild rename or alliance change doesn't
//! erase history: every distinct name/alliance value ever observed for a
//! guild gets its own row, while `enemy_guilds.name` /
//! `current_alliance_name` only ever reflect the latest known value.
//!
//! `enemy_player_battles.battle_id` is the `AlbionBB` battle id, deliberately
//! unconstrained — no foreign key — matching the established idiom already
//! used by `battle_guild_stats.battle_id` / `battle_player_stats.battle_id` /
//! `battle_kills.battle_id`, so this evidence survives independently of any
//! snapshot pruning.
//!
//! This migration is purely additive: it does not touch any existing table,
//! backfill any data, or wire anything into ingestion.

use sea_orm_migration::prelude::*;

/// Migration step creating the enemy identity tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[allow(clippy::too_many_lines)]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EnemyGuilds::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EnemyGuilds::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(EnemyGuilds::GuildKey).string().not_null())
                    .col(ColumnDef::new(EnemyGuilds::AlbionGuildId).string())
                    .col(ColumnDef::new(EnemyGuilds::Name).string().not_null())
                    .col(ColumnDef::new(EnemyGuilds::CurrentAllianceId).string())
                    .col(ColumnDef::new(EnemyGuilds::CurrentAllianceName).string())
                    .col(
                        ColumnDef::new(EnemyGuilds::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyGuilds::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyGuilds::IsWatchlisted)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(EnemyGuilds::Notes).text())
                    .col(
                        ColumnDef::new(EnemyGuilds::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(EnemyGuilds::UpdatedAt)
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
                    .name("idx_enemy_guilds_guild_key_unique")
                    .table(EnemyGuilds::Table)
                    .col(EnemyGuilds::GuildKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_guilds_last_seen_at")
                    .table(EnemyGuilds::Table)
                    .col(EnemyGuilds::LastSeenAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(EnemyGuildAliases::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EnemyGuildAliases::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EnemyGuildAliases::EnemyGuildId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(EnemyGuildAliases::Kind).string().not_null())
                    .col(ColumnDef::new(EnemyGuildAliases::Value).string().not_null())
                    .col(
                        ColumnDef::new(EnemyGuildAliases::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyGuildAliases::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_enemy_guild_aliases_enemy_guild_id")
                            .from(EnemyGuildAliases::Table, EnemyGuildAliases::EnemyGuildId)
                            .to(EnemyGuilds::Table, EnemyGuilds::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_guild_aliases_unique")
                    .table(EnemyGuildAliases::Table)
                    .col(EnemyGuildAliases::EnemyGuildId)
                    .col(EnemyGuildAliases::Kind)
                    .col(EnemyGuildAliases::Value)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(EnemyPlayers::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EnemyPlayers::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(EnemyPlayers::PlayerKey).string().not_null())
                    .col(ColumnDef::new(EnemyPlayers::AlbionPlayerId).string())
                    .col(ColumnDef::new(EnemyPlayers::Name).string().not_null())
                    .col(
                        ColumnDef::new(EnemyPlayers::IdentitySource)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(EnemyPlayers::CurrentEnemyGuildId).big_integer())
                    .col(
                        ColumnDef::new(EnemyPlayers::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayers::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayers::IsWatchlisted)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(EnemyPlayers::Notes).text())
                    .col(
                        ColumnDef::new(EnemyPlayers::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayers::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_enemy_players_current_enemy_guild_id")
                            .from(EnemyPlayers::Table, EnemyPlayers::CurrentEnemyGuildId)
                            .to(EnemyGuilds::Table, EnemyGuilds::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_players_player_key_unique")
                    .table(EnemyPlayers::Table)
                    .col(EnemyPlayers::PlayerKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_players_current_enemy_guild_id")
                    .table(EnemyPlayers::Table)
                    .col(EnemyPlayers::CurrentEnemyGuildId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_players_last_seen_at")
                    .table(EnemyPlayers::Table)
                    .col(EnemyPlayers::LastSeenAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(EnemyPlayerBattles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::EnemyPlayerId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::EnemyGuildId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(EnemyPlayerBattles::Role).string())
                    .col(ColumnDef::new(EnemyPlayerBattles::MainHandItemId).string())
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::ItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::OurKillsOnThem)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::TheirKillsOnUs)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(EnemyPlayerBattles::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_enemy_player_battles_enemy_player_id")
                            .from(EnemyPlayerBattles::Table, EnemyPlayerBattles::EnemyPlayerId)
                            .to(EnemyPlayers::Table, EnemyPlayers::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_enemy_player_battles_enemy_guild_id")
                            .from(EnemyPlayerBattles::Table, EnemyPlayerBattles::EnemyGuildId)
                            .to(EnemyGuilds::Table, EnemyGuilds::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_player_battles_unique")
                    .table(EnemyPlayerBattles::Table)
                    .col(EnemyPlayerBattles::BattleId)
                    .col(EnemyPlayerBattles::EnemyPlayerId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_player_battles_enemy_player_id")
                    .table(EnemyPlayerBattles::Table)
                    .col(EnemyPlayerBattles::EnemyPlayerId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_player_battles_enemy_guild_id")
                    .table(EnemyPlayerBattles::Table)
                    .col(EnemyPlayerBattles::EnemyGuildId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_enemy_player_battles_occurred_at")
                    .table(EnemyPlayerBattles::Table)
                    .col(EnemyPlayerBattles::OccurredAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EnemyPlayerBattles::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(EnemyPlayers::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(EnemyGuildAliases::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(EnemyGuilds::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum EnemyGuilds {
    Table,
    Id,
    GuildKey,
    AlbionGuildId,
    Name,
    CurrentAllianceId,
    CurrentAllianceName,
    FirstSeenAt,
    LastSeenAt,
    IsWatchlisted,
    Notes,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum EnemyGuildAliases {
    Table,
    Id,
    EnemyGuildId,
    Kind,
    Value,
    FirstSeenAt,
    LastSeenAt,
}

#[derive(DeriveIden)]
enum EnemyPlayers {
    Table,
    Id,
    PlayerKey,
    AlbionPlayerId,
    Name,
    IdentitySource,
    CurrentEnemyGuildId,
    FirstSeenAt,
    LastSeenAt,
    IsWatchlisted,
    Notes,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum EnemyPlayerBattles {
    Table,
    Id,
    BattleId,
    EnemyPlayerId,
    EnemyGuildId,
    OccurredAt,
    Role,
    MainHandItemId,
    ItemPower,
    OurKillsOnThem,
    TheirKillsOnUs,
    CreatedAt,
}
