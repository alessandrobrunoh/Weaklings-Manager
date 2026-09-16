//! `SeaORM` entity for `fight_stats`.
//!
//! A single table, grouped as an inner `fight_stat` module the same way
//! `modules::economy::entities`'s single-table `battle_loss_estimate` does —
//! one genuine cross-module relation to wire (to `events::entities::fight`),
//! no others. See `m20260908_000009_create_fight_stats` for the full
//! schema rationale, including why `fight_id` gets a real foreign key
//! (unlike the upstream-`battle_id`-keyed tables elsewhere in this
//! codebase), why player counts are deduplicated by `player_key`, and the
//! `enemy_estimated_loss` trade-indicator-only caveat.

pub mod fight_stat {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// A persisted, rebuildable analytics rollup for one Fight. Like
    /// `battle_loss_estimate`, this row is **replaced wholesale** every time
    /// it is recomputed — it is not an immutable-identity table like
    /// `loadout_fingerprints`.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "fight_stats")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The Fight this rollup belongs to. Unlike the deliberately
        /// unconstrained upstream-`battle_id` columns used elsewhere in this
        /// codebase, `fights` is a table this codebase owns, so this is a
        /// real foreign key (`ON DELETE CASCADE`). Unique: exactly one
        /// current rollup per fight.
        #[sea_orm(unique)]
        pub fight_id: i64,
        /// Distinct `AlbionBB` battle segments belonging to this fight.
        pub segment_count: i32,
        /// Deduplicated by `player_key` across every segment. A naive sum
        /// of per-segment player counts double-counts a player who fought
        /// in two segments of the same multi-segment fight — the same
        /// player simply reappears in the next segment's roster — so this
        /// column is computed by deduplicating identities across the whole
        /// fight, not by summing counts already computed per segment.
        pub unique_friendly_players: i32,
        /// Same deduplication as `unique_friendly_players`, for the enemy
        /// side.
        pub unique_enemy_players: i32,
        pub friendly_kills: i64,
        pub friendly_deaths: i64,
        pub friendly_kill_fame: i64,
        pub enemy_kills: i64,
        pub enemy_deaths: i64,
        pub enemy_kill_fame: i64,
        pub avg_friendly_item_power: f64,
        pub avg_enemy_item_power: f64,
        /// Summed from `battle_loss_estimates` across the fight's segments.
        pub friendly_estimated_loss: i64,
        /// Summed from `battle_loss_estimates` across the fight's segments.
        /// **A trade indicator only** — this codebase's non-negotiable rule
        /// (see `economy::mod`'s doc comment) is that guild income is
        /// declared via `splits`, never inferred from combat. This column
        /// must never be summed into any income/P&L total; it exists
        /// purely so an officer can compare it against
        /// `friendly_estimated_loss` to eyeball whether a fight was a good
        /// trade.
        pub enemy_estimated_loss: i64,
        /// When this specific rollup was computed. The reproducibility
        /// anchor, mirroring the role `priced_at` plays for
        /// `battle_loss_estimate`.
        pub computed_at: DateTimeWithTimeZone,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last time this row was replaced by a recompute.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Fight,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Fight => Entity::belongs_to(crate::modules::events::entities::fight::Entity)
                    .from(Column::FightId)
                    .to(crate::modules::events::entities::fight::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<crate::modules::events::entities::fight::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Fight.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
