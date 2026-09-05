//! `SeaORM` entities for the combat module's persisted tables.
//!
//! The bundled dataset (`combat::dataset`) and the pure math (`combat::ip`, `combat::fit`,
//! `combat::readiness`, `combat::sim`, `combat::scenario`) have no database at all — these two
//! tables are the only state the module actually owns.

pub mod combat_scenario {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// A saved combat test: one version of a declared burst window an officer can reopen, tweak
    /// and re-run. Versioned the same way `builds`/`comps` are — each version is its own row,
    /// unique on `(name, version)` — rather than a separate version-history table.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "combat_scenarios")]
    pub struct Model {
        /// The unique primary key of the scenario version.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The human-readable name shared by every version of this scenario.
        pub name: String,
        /// The version of this scenario within its `name` group. Starts at 1.
        pub version: i32,
        /// The scenario's unit groups and timeline, serialized — validated by the request DTOs at
        /// the API boundary, not by the database.
        pub definition_json: String,
        /// The user who created this version.
        pub created_by: i64,
        /// The timestamp when this version was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when this version was last updated.
        pub updated_at: DateTimeWithTimeZone,
        /// When this version was archived. `None` means it's active and offered for new use.
        pub archived_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Creator,
        Runs,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Creator => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::CreatedBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::Runs => Entity::has_many(super::combat_run::Entity).into(),
            }
        }
    }

    impl Related<crate::modules::users::entities::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Creator.def()
        }
    }

    impl Related<super::combat_run::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Runs.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod combat_run {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The pinned result of running one `combat_scenarios` version.
    ///
    /// `engine_version` and `dataset_commit` are stamped at run time so a result stays legible
    /// after an Albion patch or an engine change shifts the numbers underneath it.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "combat_runs")]
    pub struct Model {
        /// The unique primary key of the run.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The scenario version this run resolved.
        pub scenario_id: i64,
        /// Bumped whenever `combat::scenario`'s output shape changes.
        pub engine_version: i32,
        /// The ao-bin-dumps commit the dataset came from at run time.
        pub dataset_commit: String,
        /// The full [`crate::modules::combat::scenario::ScenarioResult`], serialized.
        pub result_json: String,
        /// The user who ran it.
        pub ran_by: i64,
        /// The timestamp when it was run.
        pub ran_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Scenario,
        RanBy,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Scenario => Entity::belongs_to(super::combat_scenario::Entity)
                    .from(Column::ScenarioId)
                    .to(super::combat_scenario::Column::Id)
                    .into(),
                Self::RanBy => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::RanBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::combat_scenario::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Scenario.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
