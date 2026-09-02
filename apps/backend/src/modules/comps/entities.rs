//! Sea-ORM entities for the comps module tables.
//!
//! Seven tables: build_categories, comp_categories, builds, build_items, build_item_spells,
//! comps, comp_builds.

pub mod build_category {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "build_categories")]
    pub struct Model {
        /// The unique primary key of the build category.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The human-readable name of the build category.
        pub name: String,
        /// A URL-friendly slug for the build category.
        pub slug: String,
        /// An optional description of the build category.
        pub description: Option<String>,
        /// The timestamp when the build category was created.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match *self {}
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod comp_category {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "comp_categories")]
    pub struct Model {
        /// The unique primary key of the comp category.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The human-readable name of the comp category.
        pub name: String,
        /// A URL-friendly slug for the comp category.
        pub slug: String,
        /// An optional description of the comp category.
        pub description: Option<String>,
        /// The timestamp when the comp category was created.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match *self {}
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod build {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "builds")]
    pub struct Model {
        /// The unique primary key of the build.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The human-readable name of the build.
        pub name: String,
        /// An optional description of the build.
        pub description: Option<String>,
        /// The role of the build (e.g., healer, tank, dps).
        pub role: String,
        /// The category this build belongs to.
        pub category_id: i64,
        /// The version of this build within its `(name, category_id)` group. Starts at 1.
        pub version: i32,
        /// The user who created this build.
        pub created_by: i64,
        /// The timestamp when the build was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the build was last updated.
        pub updated_at: DateTimeWithTimeZone,
        /// When this build was archived. `None` means it's active and offered for new use;
        /// archiving never deletes the row, so anything already using it keeps working.
        pub archived_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        BuildCategory,
        Creator,
        BuildItems,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::BuildCategory => Entity::belongs_to(super::build_category::Entity)
                    .from(Column::CategoryId)
                    .to(super::build_category::Column::Id)
                    .into(),
                Self::Creator => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::CreatedBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::BuildItems => Entity::has_many(super::build_item::Entity).into(),
            }
        }
    }

    impl Related<super::build_category::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::BuildCategory.def()
        }
    }

    impl Related<super::build_item::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::BuildItems.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod build_item {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "build_items")]
    pub struct Model {
        /// The unique primary key of the build item.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The build this item belongs to.
        pub build_id: i64,
        /// Which loadout this item belongs to: the main set or the swap.
        pub loadout: String,
        /// The equipment slot of this item.
        pub slot: String,
        /// The OpenAlbion item type.
        pub openalbion_item_type: String,
        /// The OpenAlbion item ID.
        pub openalbion_item_id: i64,
        /// The OpenAlbion item name.
        pub openalbion_item_name: String,
        /// The OpenAlbion item icon URL.
        pub openalbion_item_icon: Option<String>,
        /// The OpenAlbion item tier.
        pub openalbion_item_tier: Option<String>,
        /// The timestamp when the build item was created.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Build,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Build => Entity::belongs_to(super::build::Entity)
                    .from(Column::BuildId)
                    .to(super::build::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::build::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Build.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod build_item_spell {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "build_item_spells")]
    pub struct Model {
        /// The unique primary key of the ability choice.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The equipped item this ability is slotted on.
        pub build_item_id: i64,
        /// `active` or `passive`.
        pub kind: String,
        /// 1-based slot index within its kind. Active 1/2/3 are Q/W/E on a weapon.
        pub slot_index: i32,
        /// Albion's internal spell id, e.g. `HEROICSTRIKE2`.
        pub spell_id: String,
        /// The timestamp when the ability was chosen.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        BuildItem,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::BuildItem => Entity::belongs_to(super::build_item::Entity)
                    .from(Column::BuildItemId)
                    .to(super::build_item::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::build_item::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::BuildItem.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod comp {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "comps")]
    pub struct Model {
        /// The unique primary key of the comp.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The human-readable name of the comp.
        pub name: String,
        /// An optional description of the comp.
        pub description: Option<String>,
        /// The category this comp belongs to.
        pub category_id: i64,
        /// The version of this comp within its `(name, category_id)` group. Starts at 1.
        pub version: i32,
        /// The user who created this comp.
        pub created_by: i64,
        /// The timestamp when the comp was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the comp was last updated.
        /// The timestamp when the comp was last updated.
        pub updated_at: DateTimeWithTimeZone,
        /// The parent comp ID if this comp is a variant.
        pub parent_id: Option<i64>,
        /// When this comp was archived. `None` means it's active and offered for new use;
        /// archiving never deletes the row, so any event already using it keeps working.
        pub archived_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        CompCategory,
        Creator,
        CompBuilds,
        Parent,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::CompCategory => Entity::belongs_to(super::comp_category::Entity)
                    .from(Column::CategoryId)
                    .to(super::comp_category::Column::Id)
                    .into(),
                Self::Creator => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::CreatedBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::CompBuilds => Entity::has_many(super::comp_build::Entity).into(),
                Self::Parent => Entity::belongs_to(Entity)
                    .from(Column::ParentId)
                    .to(Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::comp_category::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::CompCategory.def()
        }
    }

    impl Related<super::comp_build::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::CompBuilds.def()
        }
    }

    impl Related<Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Parent.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod comp_build {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "comp_builds")]
    pub struct Model {
        /// The unique primary key of the comp build.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The comp this build belongs to.
        pub comp_id: i64,
        /// The build in the comp.
        pub build_id: i64,
        /// The quantity of this build in the comp.
        pub quantity: i32,
        /// The timestamp when the comp build was created.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Comp,
        Build,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Comp => Entity::belongs_to(super::comp::Entity)
                    .from(Column::CompId)
                    .to(super::comp::Column::Id)
                    .into(),
                Self::Build => Entity::belongs_to(super::build::Entity)
                    .from(Column::BuildId)
                    .to(super::build::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::comp::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Comp.def()
        }
    }

    impl Related<super::build::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Build.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
