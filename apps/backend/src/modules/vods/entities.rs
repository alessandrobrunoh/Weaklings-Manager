//! Sea-ORM entity for `vod_reviews`.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One claimed VOD review URL inside a season.
pub mod vod_review {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "vod_reviews")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Claimer.
        pub user_id: i64,
        /// Season the unique URL constraint is scoped to.
        pub season_id: i64,
        /// Normalized URL (trim, lowercase host, no trailing slash).
        pub url: String,
        /// Discord forum thread the `/vod` command was run in.
        pub discord_thread_id: String,
        /// Discord message id of the claim (if any).
        pub discord_message_id: String,
        /// Insert time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use vod_review::{
    ActiveModel as VodReviewActiveModel, Column as VodReviewColumn, Entity as VodReviewEntity,
    Model as VodReviewModel,
};
