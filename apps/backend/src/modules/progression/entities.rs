//! Sea-ORM entities for the progression tables.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Singleton admin knobs for the XP curve, rates, and warn threshold.
pub mod progression_setting {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "progression_settings")]
    pub struct Model {
        /// Always `1`.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// `threshold(n) = round(xp_base * (n-1)^xp_exponent)`.
        pub xp_base: i32,
        /// Exponent of the curve. Default `1.5`.
        pub xp_exponent: Decimal,
        /// Highest reachable level.
        pub max_level: i32,
        /// XP granted per eligible Discord message.
        pub xp_message: i32,
        /// XP granted for creating an event.
        pub xp_event_create: i32,
        /// XP granted for joining an event.
        pub xp_event_join: i32,
        /// XP granted for still being on the roster at event stop.
        pub xp_event_complete: i32,
        /// XP granted for a claimed VOD review.
        pub xp_vod: i32,
        /// Minimum seconds between message XP awards for one user.
        pub message_cooldown_secs: i32,
        /// Minimum message length for message XP.
        pub message_min_chars: i32,
        /// Active-warn count that opens an admin escalation.
        pub warn_threshold: i32,
        /// Discord forum channel id where VOD threads live.
        pub vod_forum_channel_id: Option<String>,
        /// JSON array of Discord channel ids that never grant message XP.
        pub message_channel_deny_list_json: String,
        /// Last admin edit.
        pub updated_at: DateTimeWithTimeZone,
        /// Last admin editor.
        pub updated_by_user_id: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// One Albion-aligned, admin-modellable season.
pub mod progression_season {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "progression_seasons")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Display name, e.g. `Albion Season 25`.
        pub name: String,
        /// Inclusive start of the XP window.
        pub starts_at: DateTimeWithTimeZone,
        /// Inclusive end of the XP window. Editable to lengthen or shorten.
        pub ends_at: DateTimeWithTimeZone,
        /// At most one row should be active; enforced in the service.
        pub is_active: bool,
        /// Last edit.
        pub updated_at: DateTimeWithTimeZone,
        /// Last editor.
        pub updated_by_user_id: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// Per-user XP/level inside one season.
pub mod progression_account {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "progression_accounts")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The guild member.
        pub user_id: i64,
        /// Season this row belongs to.
        pub season_id: i64,
        /// Season XP (never negative).
        pub xp: i64,
        /// Denormalized from `xp` + current curve.
        pub level: i32,
        /// Live XP multiplier. Default `1.0`. Clamp `[0, 5]` at write time.
        pub xp_multiplier: Decimal,
        /// When set and in the past, the next award resets the multiplier to `1`.
        pub multiplier_expires_at: Option<DateTimeWithTimeZone>,
        /// Fractional XP carried between awards (half-multipliers on 1 XP).
        pub xp_remainder: Decimal,
        /// Last time message XP was granted (cooldown).
        pub last_message_xp_at: Option<DateTimeWithTimeZone>,
        /// Insert time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// Append-only XP award log.
pub mod progression_xp_ledger {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "progression_xp_ledger")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Who received the XP.
        pub user_id: i64,
        /// Season of the award.
        pub season_id: i64,
        /// [`super::super::status::XpSource`] as a stable string.
        pub source: String,
        /// Rate before the multiplier.
        pub base_amount: i64,
        /// After multiplier + remainder (0 is valid — remainder still advanced).
        pub applied_amount: i64,
        /// Multiplier snapshotted at award time.
        pub multiplier_at_time: Decimal,
        /// Unique with `season_id`.
        pub idempotency_key: String,
        /// Officer who forced an admin adjust, if any.
        pub actor_user_id: Option<i64>,
        /// When the row was written.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use progression_account::{
    ActiveModel as ProgressionAccountActiveModel, Column as ProgressionAccountColumn,
    Entity as ProgressionAccountEntity, Model as ProgressionAccountModel,
};
pub use progression_season::{
    ActiveModel as ProgressionSeasonActiveModel, Column as ProgressionSeasonColumn,
    Entity as ProgressionSeasonEntity, Model as ProgressionSeasonModel,
};
pub use progression_setting::{
    ActiveModel as ProgressionSettingActiveModel, Entity as ProgressionSettingEntity,
    Model as ProgressionSettingModel,
};
pub use progression_xp_ledger::{
    ActiveModel as ProgressionXpLedgerActiveModel, Column as ProgressionXpLedgerColumn,
    Entity as ProgressionXpLedgerEntity, Model as ProgressionXpLedgerModel,
};
