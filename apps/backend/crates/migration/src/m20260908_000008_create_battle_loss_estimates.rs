//! Creates `battle_loss_estimates`: one priced, reproducible silver-loss
//! estimate per battle, covering both our own side and the enemy side.
//!
//! **Replaced wholesale on recompute, unlike `loadout_fingerprints`.**
//! `loadout_fingerprints` is an immutable identity table on purpose — a
//! fingerprint's identity and build match are historical facts about what
//! was observed and how the catalog looked at that moment, and must never
//! silently drift. A silver estimate is the opposite kind of fact: market
//! prices genuinely move day to day, so "how much did our victim gear cost"
//! computed today and computed next week are two different, both-correct
//! answers to the same question at different points in time. This table
//! does not try to preserve every historical estimate ever computed for a
//! battle — it holds exactly one row per battle, the current best estimate,
//! and that row is overwritten in place whenever the estimate is
//! recomputed. `priced_at` is what makes that safe: it is the
//! reproducibility anchor that tells a reader when this particular figure
//! was true, the same role `comps::models::BuildPriceView::priced_at` plays
//! for a build's market price — without it, a silver number floating around
//! with no timestamp cannot be trusted, since the market it was drawn from
//! has since moved.
//!
//! **Costs and trade estimates only — never income.** This module's own
//! doc comment (`economy::mod`) states the rule this whole module obeys:
//! guild income is *declared*, through an officer-created split's
//! `net_value`, never *inferred* from combat evidence. Nothing stored here
//! is income. `friendly_estimated_loss` is a cost figure: what our own
//! victim equipment was priced at. `enemy_estimated_loss` is not a mirror
//! credit for "money we took from them" — Albion combat does not transfer
//! silver that way, and even if it read as a proxy for enemy cost, it must
//! never be summed into any revenue/income calculation anywhere in this
//! codebase. It exists purely as a *trade indicator*: it lets an officer
//! glance at a battle and ask "did we come out ahead in the silver
//! exchange" (friendly loss vs. enemy loss), not "how much did we earn".
//! Any future reader who is tempted to add `enemy_estimated_loss` into a
//! P&L/event-income total is reintroducing exactly the inferred-income bug
//! this module exists to prevent.
//!
//! `battle_id` is the `AlbionBB` battle id, deliberately unconstrained — no
//! foreign key — matching the established idiom already used by
//! `battle_guild_stats.battle_id` / `battle_player_stats.battle_id` /
//! `battle_kills.battle_id` / `enemy_player_battles.battle_id` /
//! `battle_loadout_observations.battle_id`.
//!
//! This migration is purely additive: it does not touch any existing table,
//! backfill any data, or wire anything into ingestion.

use sea_orm_migration::prelude::*;

/// Migration step creating `battle_loss_estimates`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[allow(clippy::too_many_lines)]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BattleLossEstimates::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattleLossEstimates::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::FriendlyEstimatedLoss)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::FriendlyPricedItems)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::FriendlyTotalItems)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::EnemyEstimatedLoss)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::EnemyPricedItems)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::EnemyTotalItems)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::PricingLocation)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::PricedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(BattleLossEstimates::UpdatedAt)
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
                    .name("idx_battle_loss_estimates_battle_id_unique")
                    .table(BattleLossEstimates::Table)
                    .col(BattleLossEstimates::BattleId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_loss_estimates_priced_at")
                    .table(BattleLossEstimates::Table)
                    .col(BattleLossEstimates::PricedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BattleLossEstimates::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum BattleLossEstimates {
    Table,
    Id,
    BattleId,
    FriendlyEstimatedLoss,
    FriendlyPricedItems,
    FriendlyTotalItems,
    EnemyEstimatedLoss,
    EnemyPricedItems,
    EnemyTotalItems,
    PricingLocation,
    PricedAt,
    CreatedAt,
    UpdatedAt,
}
