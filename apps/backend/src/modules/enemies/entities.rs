//! `SeaORM` entities for the enemy identity tables.
//!
//! Four related tables, grouped as inner modules the same way
//! `modules::battles::evidence_entities` does, rather than as one flat entity
//! file: `enemy_guild`, `enemy_guild_alias`, `enemy_player` and
//! `enemy_player_battle`. See `m20260908_000005_create_enemy_identity_tables`
//! for the full identity-vs-rollup rationale.

pub mod enemy_guild {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The canonical, officer-correctable identity row for one enemy guild.
    ///
    /// Deliberately carries no derived rollups (battle counts, kill totals,
    /// …) — those are computed at read time from `enemy_player_battles`. See
    /// `m20260908_000005_create_enemy_identity_tables` for why.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "enemy_guilds")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Opaque identity key the caller computes — `"id:<albion guild id>"`
        /// when the payload carried a guild id, `"name:<lowercased name>"`
        /// otherwise. Mirrors `battle_player_stats.player_key`'s fallback
        /// rule; Albion guild ids can be empty on messy payloads, same as
        /// player ids.
        pub guild_key: String,
        /// Raw Albion guild id, when present.
        pub albion_guild_id: Option<String>,
        /// Latest known display name. Historical values live in
        /// `enemy_guild_aliases`.
        pub name: String,
        /// Alliance id the guild currently belongs to, when known.
        pub current_alliance_id: Option<String>,
        /// Alliance display name the guild currently belongs to, when known.
        pub current_alliance_name: Option<String>,
        /// When this guild was first observed.
        pub first_seen_at: DateTimeWithTimeZone,
        /// When this guild was most recently observed.
        pub last_seen_at: DateTimeWithTimeZone,
        /// Officer-set flag marking this guild for closer attention.
        pub is_watchlisted: bool,
        /// Free-form officer notes.
        pub notes: Option<String>,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation of this row.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Aliases,
        Players,
        PlayerBattles,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Aliases => Entity::has_many(super::enemy_guild_alias::Entity).into(),
                Self::Players => Entity::has_many(super::enemy_player::Entity).into(),
                Self::PlayerBattles => Entity::has_many(super::enemy_player_battle::Entity).into(),
            }
        }
    }

    impl Related<super::enemy_guild_alias::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Aliases.def()
        }
    }

    impl Related<super::enemy_player::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Players.def()
        }
    }

    impl Related<super::enemy_player_battle::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::PlayerBattles.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod enemy_guild_alias {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One distinct name/alliance value ever observed for an enemy guild, so
    /// a rename or alliance change doesn't erase history. `enemy_guilds`
    /// only ever reflects the latest known value; this table is the full
    /// history.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "enemy_guild_aliases")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The guild this alias was observed for.
        pub enemy_guild_id: i64,
        /// What kind of value this alias records: `"name"` or `"alliance"`.
        /// Plain text, not an enum/check constraint.
        pub kind: String,
        /// The observed value itself.
        pub value: String,
        /// When this value was first observed.
        pub first_seen_at: DateTimeWithTimeZone,
        /// When this value was most recently observed.
        pub last_seen_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        EnemyGuild,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::EnemyGuild => Entity::belongs_to(super::enemy_guild::Entity)
                    .from(Column::EnemyGuildId)
                    .to(super::enemy_guild::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::enemy_guild::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::EnemyGuild.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod enemy_player {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The canonical, officer-correctable identity row for one enemy player.
    ///
    /// Deliberately carries no derived rollups (battle counts, kill totals,
    /// …) — those are computed at read time from `enemy_player_battles`. See
    /// `m20260908_000005_create_enemy_identity_tables` for why.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "enemy_players")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Opaque identity key, same fallback scheme as
        /// `battle_player_stats.player_key` — in fact, for a player already
        /// scoped as an enemy, this value IS that column's value for the
        /// player, re-used as the same opaque key across battles here.
        pub player_key: String,
        /// Raw Albion player id, when present.
        pub albion_player_id: Option<String>,
        /// Latest known display name.
        pub name: String,
        /// How `player_key` was derived: `"player_id"` or `"name_only"`.
        /// Plain text, not an enum/check constraint.
        pub identity_source: String,
        /// The enemy guild this player is currently believed to belong to,
        /// when known. Nullable and `ON DELETE SET NULL`: a player's guild
        /// identity can be established even if we later lose track of which
        /// enemy guild row it points to — this must never cascade-delete a
        /// player because their guild row happened to be removed.
        pub current_enemy_guild_id: Option<i64>,
        /// When this player was first observed.
        pub first_seen_at: DateTimeWithTimeZone,
        /// When this player was most recently observed.
        pub last_seen_at: DateTimeWithTimeZone,
        /// Officer-set flag marking this player for closer attention.
        pub is_watchlisted: bool,
        /// Free-form officer notes.
        pub notes: Option<String>,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation of this row.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        CurrentEnemyGuild,
        Battles,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::CurrentEnemyGuild => Entity::belongs_to(super::enemy_guild::Entity)
                    .from(Column::CurrentEnemyGuildId)
                    .to(super::enemy_guild::Column::Id)
                    .into(),
                Self::Battles => Entity::has_many(super::enemy_player_battle::Entity).into(),
            }
        }
    }

    impl Related<super::enemy_guild::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::CurrentEnemyGuild.def()
        }
    }

    impl Related<super::enemy_player_battle::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Battles.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod enemy_player_battle {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The append-only bridge from one enemy player to one battle they were
    /// observed in, fighting us. This is where every rollup (battles fought,
    /// kills traded, builds observed, item power over time) is actually
    /// computed from at read time — deliberately not duplicated onto
    /// `enemy_guilds`/`enemy_players`. See
    /// `m20260908_000005_create_enemy_identity_tables` for why.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "enemy_player_battles")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical `AlbionBB` battle id. Deliberately unconstrained (no
        /// foreign key), matching the established idiom already used by
        /// `battle_guild_stats.battle_id` / `battle_player_stats.battle_id` /
        /// `battle_kills.battle_id`, so this evidence survives independently
        /// of any snapshot pruning.
        pub battle_id: i64,
        /// The enemy player observed in this battle.
        pub enemy_player_id: i64,
        /// The enemy guild this player was fighting for in this battle.
        pub enemy_guild_id: i64,
        /// The battle's own time, not row-insertion time, so read-time
        /// queries can filter by real-world period without joining
        /// elsewhere.
        pub occurred_at: DateTimeWithTimeZone,
        /// Assigned combat role, when classified.
        pub role: Option<String>,
        /// Raw upstream item type id of the player's main-hand weapon, when
        /// observed.
        pub main_hand_item_id: Option<String>,
        /// This player's item power, as observed in this battle.
        pub item_power: f64,
        /// Kills we landed on this player within this one battle.
        pub our_kills_on_them: i32,
        /// Kills this player landed on us within this one battle.
        pub their_kills_on_us: i32,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        EnemyPlayer,
        EnemyGuild,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::EnemyPlayer => Entity::belongs_to(super::enemy_player::Entity)
                    .from(Column::EnemyPlayerId)
                    .to(super::enemy_player::Column::Id)
                    .into(),
                Self::EnemyGuild => Entity::belongs_to(super::enemy_guild::Entity)
                    .from(Column::EnemyGuildId)
                    .to(super::enemy_guild::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::enemy_player::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::EnemyPlayer.def()
        }
    }

    impl Related<super::enemy_guild::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::EnemyGuild.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
