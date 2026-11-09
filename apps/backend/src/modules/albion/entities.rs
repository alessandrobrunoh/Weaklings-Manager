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

pub mod albion_link_request {
    use sea_orm::entity::prelude::*;

    /// A self-service claim on an Albion character that no officer has approved yet.
    ///
    /// Deliberately a separate table from `albion_links`: every feature that attributes loot,
    /// regears or splits to a character reads `albion_links`, so an unvetted claim must not live
    /// there.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
    #[sea_orm(table_name = "albion_link_requests")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Discord user snowflake ID. Unique: one open request per account.
        #[sea_orm(unique)]
        pub discord_id: String,
        /// Albion Online player ID being claimed. Not unique: several accounts may claim the same
        /// character and the officer picks the real owner.
        pub albion_player_id: String,
        /// Albion player display name at request time.
        pub albion_player_name: String,
        /// Name of the Albion guild the character belonged to at request time, for the reviewer.
        pub albion_guild_name: Option<String>,
        /// Entry point: `self` or `register`.
        pub via: String,
        pub requested_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
