//! Sea-ORM entities for the `splits` and `split_participants` tables.

pub mod split {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "splits")]
    pub struct Model {
        /// The unique primary key of the split.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The user who created the split.
        pub created_by: i64,
        /// The lifecycle status of the split: `"draft"` or `"finalized"`.
        pub status: String,
        /// The estimated market value of the loot before deductions.
        pub estimated_market_value: Decimal,
        /// The repair costs deducted from the market value.
        pub repair_value: Decimal,
        /// The bags/consumables costs deducted from the market value.
        pub bags_value: Decimal,
        /// The net value distributed among participants, set only once finalized.
        pub net_value: Option<Decimal>,
        /// An optional free-text note (e.g. boss/item name).
        pub note: Option<String>,
        /// Event this split belongs to, when the loot came from a tracked event.
        pub event_id: Option<i64>,
        /// The timestamp when the split was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the split was finalized, if it has been.
        pub finalized_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Participants,
        Creator,
        Event,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Participants => Entity::has_many(super::split_participant::Entity).into(),
                Self::Creator => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::CreatedBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::Event => Entity::belongs_to(crate::modules::events::entities::event::Entity)
                    .from(Column::EventId)
                    .to(crate::modules::events::entities::event::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::split_participant::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Participants.def()
        }
    }

    impl Related<crate::modules::events::entities::event::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Event.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod split_participant {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "split_participants")]
    pub struct Model {
        /// The unique primary key of the split participant row.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The split this participant belongs to.
        pub split_id: i64,
        /// The user participating in the split.
        pub user_id: i64,
        /// The normalized weight of this participant relative to other participants in the split.
        pub weight: i32,
        /// The timestamp when the participant was added.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Split,
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Split => Entity::belongs_to(super::split::Entity)
                    .from(Column::SplitId)
                    .to(super::split::Column::Id)
                    .into(),
                Self::User => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::UserId)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::split::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Split.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
