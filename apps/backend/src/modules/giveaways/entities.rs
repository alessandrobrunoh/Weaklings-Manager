//! Sea-ORM entities for giveaways, prizes, and entries.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

pub mod giveaway {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "giveaways")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Public title posted on Discord.
        pub title: String,
        /// Optional description posted on Discord.
        pub description: Option<String>,
        /// Instant after which entries are refused and a draw is due.
        pub ends_at: DateTimeWithTimeZone,
        /// [`super::super::status::GiveawayStatus`] as a stable string.
        pub status: String,
        /// Officer who created the giveaway.
        pub created_by: i64,
        /// Creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Optional Guild Bank silver credited to the winner.
        pub silver_amount: Option<Decimal>,
        /// Winner, once drawn.
        pub winner_user_id: Option<i64>,
        /// When the draw ran.
        pub drawn_at: Option<DateTimeWithTimeZone>,
        /// Guild Bank row created for the silver prize, if any.
        pub silver_transaction_id: Option<i64>,
        /// Discord message snowflake of the announcement.
        pub discord_message_id: Option<String>,
        /// Discord channel snowflake the announcement was posted in.
        pub discord_channel_id: Option<String>,
        /// When an officer cancelled an open giveaway.
        pub cancelled_at: Option<DateTimeWithTimeZone>,
        /// Officer who cancelled, if any.
        pub cancelled_by: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod giveaway_prize {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "giveaway_prizes")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Parent giveaway.
        pub giveaway_id: i64,
        /// OpenAlbion catalog id.
        pub openalbion_item_id: i64,
        /// Display name snapshotted at create time.
        pub openalbion_item_name: String,
        /// Render URL, quality-adjusted.
        pub openalbion_item_icon: Option<String>,
        /// Unique Albion identifier, including enchantment suffix when present.
        pub openalbion_item_identifier: Option<String>,
        /// Tier label, e.g. `T8` or `8.3`.
        pub openalbion_item_tier: Option<String>,
        /// Albion quality `1..=5`.
        pub openalbion_item_quality: i16,
        /// How many of this item the winner receives in-game.
        pub quantity: i32,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod giveaway_entry {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "giveaway_entries")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Parent giveaway.
        pub giveaway_id: i64,
        /// Linked Manager user who entered from Discord.
        pub user_id: i64,
        /// Entry time.
        pub entered_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use giveaway::{
    ActiveModel as GiveawayActiveModel, Column as GiveawayColumn, Entity as GiveawayEntity,
    Model as GiveawayModel,
};
pub use giveaway_entry::{
    ActiveModel as GiveawayEntryActiveModel, Column as GiveawayEntryColumn,
    Entity as GiveawayEntryEntity,
};
pub use giveaway_prize::{
    ActiveModel as GiveawayPrizeActiveModel, Column as GiveawayPrizeColumn,
    Entity as GiveawayPrizeEntity, Model as GiveawayPrizeModel,
};
