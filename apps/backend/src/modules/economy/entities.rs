//! `SeaORM` entity for `battle_loss_estimates`.
//!
//! A single table, grouped as an inner `battle_loss_estimate` module the
//! same way `modules::battles::entities`'s single-table `guild_battle_snapshot`
//! does — no cross-entity relations to wire. See
//! `m20260908_000008_create_battle_loss_estimates` for the full
//! replace-wholesale-on-recompute and income-is-declared-never-inferred
//! rationale.

pub mod battle_loss_estimate {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One priced, reproducible silver-loss estimate per battle, covering
    /// both our own side and the enemy side. Unlike `loadout_fingerprints`,
    /// this row is **replaced wholesale** every time the estimate is
    /// recomputed — market prices drift, and the point of this table is
    /// "our best current estimate", not an immutable historical fact.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_loss_estimates")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical `AlbionBB` battle id. Deliberately unconstrained (no
        /// foreign key), matching the established idiom already used by
        /// `battle_guild_stats.battle_id` / `battle_player_stats.battle_id`
        /// / `battle_kills.battle_id` / `enemy_player_battles.battle_id` /
        /// `battle_loadout_observations.battle_id`. Unique: this table
        /// holds exactly one current estimate per battle.
        #[sea_orm(unique)]
        pub battle_id: i64,
        /// Silver value of our side's priced victim equipment for this
        /// battle. A cost figure, never income.
        pub friendly_estimated_loss: i64,
        /// How many of our side's victim item stacks actually got a market
        /// price.
        pub friendly_priced_items: i32,
        /// How many of our side's victim item stacks existed at all — the
        /// denominator for a coverage percentage
        /// (`friendly_priced_items / friendly_total_items`).
        pub friendly_total_items: i32,
        /// Silver value of the enemy side's priced victim equipment for
        /// this battle. **This is a trade indicator only** — it must never
        /// be summed into any "income" total anywhere in this codebase. It
        /// exists purely so an officer can see "did we come out ahead in
        /// the silver trade" (friendly loss vs. enemy loss), never "how
        /// much did we earn"; this module's own rule is that guild income
        /// is declared via `splits`, never inferred from combat.
        pub enemy_estimated_loss: i64,
        /// How many of the enemy side's victim item stacks actually got a
        /// market price.
        pub enemy_priced_items: i32,
        /// How many of the enemy side's victim item stacks existed at all
        /// — the denominator for a coverage percentage
        /// (`enemy_priced_items / enemy_total_items`).
        pub enemy_total_items: i32,
        /// The city/market location this estimate was priced against (e.g.
        /// `"Caerleon"`), same vocabulary as
        /// `regear_settings.pricing_location`.
        pub pricing_location: String,
        /// When this specific estimate was computed. The reproducibility
        /// anchor: a silver figure without this timestamp cannot be
        /// trusted, since market prices move. Mirrors the role
        /// `comps::models::BuildPriceView::priced_at` plays for a build's
        /// market price.
        pub priced_at: DateTimeWithTimeZone,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last time this row was replaced by a recompute.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
