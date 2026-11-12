//! Sea-ORM entity for the `albion_links` table (Discord user <-> Albion player link).

pub mod albion_link {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
    #[sea_orm(table_name = "albion_links")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Discord user snowflake ID. Unique: one Discord account can hold at most one link.
        #[sea_orm(unique)]
        pub discord_id: String,
        /// Albion Online player ID. Unique: one Albion player can be claimed by at most one account.
        #[sea_orm(unique)]
        pub albion_player_id: String,
        /// Cached Albion player display name at link time, for display without extra API calls.
        pub albion_player_name: String,
        pub linked_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
