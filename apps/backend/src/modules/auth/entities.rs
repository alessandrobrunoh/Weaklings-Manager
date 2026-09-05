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
        /// Discord guild role snowflake this gestionale role is linked to.
        ///
        /// Login and `/me` match a member's Discord roles against this column, not against `id`.
        /// `None` means the role is gestionale-only (the default fallback role is typically unlinked).
        pub discord_role_id: Option<String>,
        /// When true, members who hold no linked Discord role receive this role.
        /// At most one row may be default (enforced by a partial unique index).
        pub is_default: bool,
        /// Unique generic staff ping role. Its Discord link is assigned automatically to
        /// members who hold any `grants_staff` role, so `@staff` reaches the whole staff.
        pub is_staff: bool,
        /// Holders of this linked Discord role also receive the generic staff ping role.
        pub grants_staff: bool,
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
