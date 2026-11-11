//! Sea-ORM entities for the regear tables.
//!
//! `regear_deaths` is the per-death workflow row; `regear_settings` is the singleton admin knobs.
//! JSON columns are stored as `Text` so the migration is portable across PostgreSQL and the
//! in-memory SQLite used by tests (same convention as `guild_battle_snapshots`).

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use backend_core::errors::AppError;

/// One eligible death of a guild member in a battle linked to a `call_to_arms` event.
pub mod regear_death {
    use super::{
        ActiveEnum, ActiveModelBehavior, ActiveModelTrait, DateTimeWithTimeZone, Decimal,
        DeriveEntityModel, DerivePrimaryKey, DeriveRelation, Deserialize, EnumIter, Iden,
        ModelTrait, PrimaryKeyTrait, Serialize,
    };

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "regear_deaths")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The CTA event the death belongs to.
        pub event_id: i64,
        /// The `event_battles` row the death came from. `None` for a self-reported request,
        /// which has no battle/kill-feed origin.
        pub event_battle_id: Option<i64>,
        /// `AlbionBB` battle id (denormalized for drill-down). `None` for a self-reported request.
        pub albionbb_battle_id: Option<String>,
        /// `AlbionBB` kill-event id (the kill feed entry that recorded this death). `None` for a
        /// self-reported request.
        pub albion_kill_event_id: Option<String>,
        /// When the death occurred, taken from the kill event. For a self-reported request, the
        /// submission time.
        pub killed_at: DateTimeWithTimeZone,
        /// The Discord-linked user id of the victim, or `None` if unlinked.
        pub user_id: Option<i64>,
        /// Albion in-game name of the victim, stored verbatim.
        pub player_name: String,
        /// `AlbionBB` guild id at time of death (always the configured guild).
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
        /// `extracted` (born from the kill-feed extractor) or `self_reported` (member-initiated,
        /// see [`crate::status::regear::RegearSource`]).
        pub source: String,
        /// The loadout actually priced, when it differs from `loadout_json` because the member
        /// edited individual slots for a self-reported request. `None` when unedited.
        pub override_loadout_json: Option<String>,
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
    use super::{
        ActiveEnum, ActiveModelBehavior, ActiveModelTrait, DateTimeWithTimeZone, DeriveEntityModel,
        DerivePrimaryKey, DeriveRelation, Deserialize, EnumIter, Iden, ModelTrait, PrimaryKeyTrait,
        Serialize,
    };

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "regear_settings")]
    pub struct Model {
        /// Always `1` (singleton guard).
        #[sea_orm(primary_key)]
        pub id: i64,
        /// How many requests are added to a user's weekly pool each elapsed week (lazily
        /// computed — see `regear::credits`).
        pub weekly_request_topup_amount: i32,
        /// The weekly pool never accumulates past this cap, even across many unused weeks.
        pub weekly_request_cap: i32,
        /// The bonus pool (only ever credited by a giveaway prize) never accumulates past this
        /// cap, even from a single large credit.
        pub bonus_request_cap: i32,
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

/// Per-user regear request-credit balance: a weekly rollover pool plus a giveaway-earned bonus
/// pool. One row per user, created lazily on first need (see `regear::credits`).
pub mod regear_request_balance {
    use super::{
        ActiveEnum, ActiveModelBehavior, ActiveModelTrait, DateTimeWithTimeZone, DeriveEntityModel,
        DerivePrimaryKey, DeriveRelation, Deserialize, EnumIter, Iden, ModelTrait, PrimaryKeyTrait,
        Serialize,
    };

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "regear_request_balances")]
    pub struct Model {
        /// The user this balance belongs to. No explicit FK, matching `regear_deaths.user_id`.
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: i64,
        /// Requests available from the weekly pool, as of `weekly_last_topup_at`.
        pub weekly_balance: i32,
        /// Anchor timestamp the weekly pool was last advanced from. Advanced lazily by whole
        /// elapsed weeks on every read/write (see `regear::credits::apply_weekly_topup`).
        pub weekly_last_topup_at: DateTimeWithTimeZone,
        /// Requests available from the bonus pool. Only ever credited by a giveaway prize;
        /// never regenerates on its own.
        pub bonus_balance: i32,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation time.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use regear_death::{
    ActiveModel as RegearDeathActiveModel, Column as RegearDeathColumn,
    Entity as RegearDeathEntity, Model as RegearDeathModel,
};
pub use regear_request_balance::{
    ActiveModel as RegearRequestBalanceActiveModel, Column as RegearRequestBalanceColumn,
    Entity as RegearRequestBalanceEntity, Model as RegearRequestBalanceModel,
};
pub use regear_setting::{
    ActiveModel as RegearSettingActiveModel, Entity as RegearSettingEntity,
    Model as RegearSettingModel,
};

/// The fallback strategy for choosing a price when the configured city has no listing.
#[derive(Debug, Clone, Copy)]
pub enum PricingFallback {
    /// Use the cheapest listing across all cities (default).
    CheapestAny,
    /// Only honor listings in the configured city; otherwise the slot is priced at 0.
    Strict,
}

impl PricingFallback {
    /// Parses the strategy string stored in `regear_settings.pricing_fallback_strategy`.
    #[must_use]
    #[allow(
        clippy::should_implement_trait,
        reason = "infallible: unknown strategies fall back to the default, so FromStr's error type would be unused"
    )]
    pub fn from_str(strategy: &str) -> Self {
        match strategy {
            "strict" => Self::Strict,
            _ => Self::CheapestAny,
        }
    }
}

/// Loads the singleton settings row, raising `Internal` if it is missing (it is seeded by the
/// migration so this should only happen on a corrupted DB).
///
/// Generic over `ConnectionTrait` (not just `DatabaseConnection`) so `giveaways::service` can
/// call it with `&txn` from inside its own draw transaction — acquiring a second pool connection
/// there instead would deadlock a single-connection SQLite pool. `pub` for that same
/// cross-module use.
pub async fn load_settings<C>(db: &C) -> Result<RegearSettingModel, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    RegearSettingEntity::find()
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal("regear_settings singleton row is missing".to_string()))
}
