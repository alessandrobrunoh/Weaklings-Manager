//! Sea-ORM entities for the regear tables.
//!
//! `regear_deaths` is the per-death workflow row; `regear_settings` is the singleton admin knobs.
//! JSON columns are stored as `Text` so the migration is portable across PostgreSQL and the
//! in-memory SQLite used by tests (same convention as `guild_battle_snapshots`).

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One eligible death of a guild member in a battle linked to a `call_to_arms` event.
pub mod regear_death {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "regear_deaths")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The CTA event the death belongs to.
        pub event_id: i64,
        /// The `event_battles` row the death came from.
        pub event_battle_id: i64,
        /// AlbionBB battle id (denormalized for drill-down).
        pub albionbb_battle_id: String,
        /// AlbionBB kill-event id (the kill feed entry that recorded this death).
        pub albion_kill_event_id: String,
        /// When the death occurred, taken from the kill event.
        pub killed_at: DateTimeWithTimeZone,
        /// The Discord-linked user id of the victim, or `None` if unlinked.
        pub user_id: Option<i64>,
        /// Albion in-game name of the victim, stored verbatim.
        pub player_name: String,
        /// AlbionBB guild id at time of death (always the configured guild).
        pub guild_id: String,
        /// The build the victim signed up with for the event, if any.
        pub primary_build_id: Option<i64>,
        /// Frozen kill-feed `Equipment` JSON for the victim.
        pub loadout_json: String,
        /// Σ of cheapest-sell prices for included slots at extraction time.
        pub auto_estimate_total: Decimal,
        /// Array of `{ slot, item_id, quality, unit_price, quantity, included }` at extraction.
        pub auto_estimate_breakdown_json: String,
        /// Workflow status: `available` / `pending` / `approved` / `rejected`.
        pub status: String,
        /// When the user requested regear, if they have.
        pub requested_at: Option<DateTimeWithTimeZone>,
        /// When an officer accepted or rejected, if decided.
        pub decided_at: Option<DateTimeWithTimeZone>,
        /// Officer who made the decision.
        pub decided_by_user_id: Option<i64>,
        /// The officer's accepted amount (after slot edits/overrides).
        pub final_amount: Option<Decimal>,
        /// Officer's edited breakdown JSON.
        pub final_breakdown_json: Option<String>,
        /// Free-form officer note (mandatory on reject).
        pub officer_note: Option<String>,
        /// The bank row created on accept, for audit.
        pub bank_transaction_id: Option<i64>,
        /// Extraction time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation time.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// Singleton table holding guild-wide regear tunables (admin-editable).
pub mod regear_setting {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "regear_settings")]
    pub struct Model {
        /// Always `1` (singleton guard).
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Max regears a user can request per CTA event.
        pub max_regears_per_event: i32,
        /// Max regears approved per user in a rolling 30-day window.
        pub max_regears_per_month: i32,
        /// Bitmask over `BuildSlot` deciding which slots are reimbursable.
        pub enabled_slots_mask: i32,
        /// Albion city whose market prices are used for estimates.
        pub pricing_location: String,
        /// `cheapest_any` (fallback across cities) or `strict`.
        pub pricing_fallback_strategy: String,
        /// Last admin edit.
        pub updated_at: DateTimeWithTimeZone,
        /// Last admin editor.
        pub updated_by_user_id: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use regear_death::{
    ActiveModel as RegearDeathActiveModel, Column as RegearDeathColumn,
    Entity as RegearDeathEntity, Model as RegearDeathModel,
};
pub use regear_setting::{
    ActiveModel as RegearSettingActiveModel, Column as RegearSettingColumn,
    Entity as RegearSettingEntity, Model as RegearSettingModel,
};
