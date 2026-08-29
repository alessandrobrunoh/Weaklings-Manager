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
        /// Island tab where the loot sits. `None` on historical splits created before locations.
        pub island_tab_id: Option<i64>,
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
        IslandTab,
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
                Self::IslandTab => Entity::belongs_to(super::split_island_tab::Entity)
                    .from(Column::IslandTabId)
                    .to(super::split_island_tab::Column::Id)
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

    impl Related<super::split_island_tab::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::IslandTab.def()
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

pub mod split_island {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// A guild island in a royal city, used as a loot-storage location.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "split_islands")]
    pub struct Model {
        /// Primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Display name of the island.
        pub name: String,
        /// Albion city key (`lymhurst`, `bridgewatch`, …).
        pub city: String,
        /// When the island was added to the catalog.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Tabs,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Tabs => Entity::has_many(super::split_island_tab::Entity).into(),
            }
        }
    }

    impl Related<super::split_island_tab::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Tabs.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod split_island_tab {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// A named chest tab on a guild island.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "split_island_tabs")]
    pub struct Model {
        /// Primary key; this is the `island_tab_id` stored on a split.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Parent island.
        pub island_id: i64,
        /// Free-text tab name.
        pub name: String,
        /// Display order within the island.
        pub sort_order: i32,
        /// When the tab was added.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Island,
        Splits,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Island => Entity::belongs_to(super::split_island::Entity)
                    .from(Column::IslandId)
                    .to(super::split_island::Column::Id)
                    .into(),
                Self::Splits => Entity::has_many(super::split::Entity).into(),
            }
        }
    }

    impl Related<super::split_island::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Island.def()
        }
    }

    impl Related<super::split::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Splits.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
