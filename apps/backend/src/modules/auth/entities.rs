//! Sea-ORM entities for database-mapped roles and role→permission mappings.

pub mod role {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
    #[sea_orm(table_name = "roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        #[sea_orm(unique)]
        pub name: String,
        pub priority: i32,
    }

    #[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod role_permission {
    use sea_orm::entity::prelude::*;

    /// A single `(role_id, permission)` row. The `permission` column holds the
    /// stable string form of a [`Permission`](super::super::permissions::Permission)
    /// variant (see `Permission::as_str`).
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
    #[sea_orm(table_name = "role_permissions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub role_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub permission: String,
    }

    #[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
