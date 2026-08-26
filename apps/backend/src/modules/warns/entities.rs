//! Sea-ORM entities for the warn register.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One issued warn. Revocation is a soft flag, never a delete.
pub mod user_warn {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "user_warns")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Target member.
        pub user_id: i64,
        /// Officer who issued the warn.
        pub issued_by_user_id: i64,
        /// Required reason text.
        pub reason: String,
        /// [`super::super::status::WarnSeverity`] as a stable string.
        pub severity: String,
        /// Optional XP multiplier applied to the covering-season account.
        pub multiplier: Option<Decimal>,
        /// Optional expiry for that multiplier.
        pub multiplier_expires_at: Option<DateTimeWithTimeZone>,
        /// When set, the row is revoked and no longer counts toward the threshold.
        pub revoked_at: Option<DateTimeWithTimeZone>,
        /// Officer who revoked, if any.
        pub revoked_by: Option<i64>,
        /// Issue time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// Admin kick-reminder opened when active warns reach `warn_threshold`.
pub mod warn_escalation {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "warn_escalations")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Target member.
        pub user_id: i64,
        /// `warn_threshold` snapshotted when this row was opened.
        pub threshold_at_time: i32,
        /// Active-warn count at open time.
        pub warn_count_at_time: i32,
        /// Open time.
        pub opened_at: DateTimeWithTimeZone,
        /// When an officer marked it handled.
        pub acknowledged_at: Option<DateTimeWithTimeZone>,
        /// Officer who acknowledged.
        pub acknowledged_by: Option<i64>,
        /// Why it closed without (or before) ack, e.g. `revoked_under_threshold`.
        pub closed_reason: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use user_warn::{
    ActiveModel as UserWarnActiveModel, Column as UserWarnColumn, Entity as UserWarnEntity,
    Model as UserWarnModel,
};
pub use warn_escalation::{
    ActiveModel as WarnEscalationActiveModel, Column as WarnEscalationColumn,
    Entity as WarnEscalationEntity, Model as WarnEscalationModel,
};
