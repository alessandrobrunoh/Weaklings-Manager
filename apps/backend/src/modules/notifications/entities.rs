//! Sea-ORM entities for the in-app notification inbox.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Officer-composed guild announcement. Fan-out rows point here via `source_id`.
pub mod notification_broadcast {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "notification_broadcasts")]
    pub struct Model {
        /// Surrogate primary key, reused as `notifications.source_id`.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Announcement title.
        pub title: String,
        /// Announcement body.
        pub body: String,
        /// Officer who composed it.
        pub created_by_user_id: i64,
        /// Compose time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// One inbox row for one recipient.
pub mod notification {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "notifications")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Recipient.
        pub user_id: i64,
        /// [`NotificationKind`](super::super::status::NotificationKind) as a stable string.
        pub kind: String,
        /// Short title shown in the bell panel.
        pub title: String,
        /// Body text.
        pub body: String,
        /// Optional in-app path (`/events/12`).
        pub link_path: Option<String>,
        /// Source table/kind (`broadcast`, `regear_death`, `event`, …).
        pub source_type: String,
        /// Source row id. Combined with `kind` + `user_id` for idempotency.
        pub source_id: i64,
        /// Actor who caused the notification, if any.
        pub created_by_user_id: Option<i64>,
        /// When the recipient marked it read.
        pub read_at: Option<DateTimeWithTimeZone>,
        /// [`super::super::status::DiscordDmStatus`] as a stable string.
        pub discord_dm_status: String,
        /// Delivery attempts by the DM worker.
        pub discord_dm_attempts: i32,
        /// Last Discord error, truncated.
        pub discord_dm_last_error: Option<String>,
        /// Insert time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use notification::{
    ActiveModel as NotificationActiveModel, Column as NotificationColumn,
    Entity as NotificationEntity, Model as NotificationModel,
};
pub use notification_broadcast::ActiveModel as NotificationBroadcastActiveModel;
