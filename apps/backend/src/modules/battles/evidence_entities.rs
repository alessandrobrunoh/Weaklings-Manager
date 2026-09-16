//! `SeaORM` entities for the battle evidence tables.
//!
//! Today a battle's per-guild tallies, per-player stat lines, kill feed and
//! victim equipment all live nested inside the JSON blobs on
//! `guild_battle_snapshots`. These four tables give that same data real,
//! indexed columns so a specific player, guild or kill can be filtered and
//! aggregated in SQL instead of loaded and parsed row by row. See
//! `m20260908_000004_create_battle_evidence_tables` for the full rationale.
//!
//! Four related tables, grouped as inner modules the same way
//! `modules::intel::entities` does, rather than as one flat entity file.

pub mod battle_guild_stat {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One row per battle x guild: that guild's aggregate tally for one
    /// `AlbionBB` battle.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_guild_stats")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical `AlbionBB` battle id. Deliberately not a foreign key to
        /// `guild_battle_snapshots.battle_id` (same idiom as
        /// `scouted_comp_battles.battle_id` and `fight_battles.battle_id`),
        /// so this evidence survives snapshot pruning.
        pub battle_id: i64,
        /// Albion guild id. May be an empty string on messy upstream
        /// payloads; tolerated rather than constrained.
        pub guild_id: String,
        /// Guild display name.
        pub guild_name: String,
        /// Alliance id, when the battle payload carried one.
        pub alliance_id: Option<String>,
        /// Alliance display name, when present.
        pub alliance_name: Option<String>,
        /// Whether this is the configured guild's own row.
        pub is_friendly: bool,
        /// Number of this guild's players observed in the battle.
        pub players: i32,
        /// Kills landed by this guild in the battle.
        pub kills: i32,
        /// Deaths suffered by this guild in the battle.
        pub deaths: i32,
        /// Total fame earned by this guild's kills.
        pub kill_fame: i64,
        /// Mean item power across this guild's observed players.
        pub avg_item_power: f64,
        /// Whether `AlbionBB` marked this guild the winning side.
        pub winner: bool,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod battle_player_stat {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One row per battle x player: that player's stat line for one
    /// `AlbionBB` battle.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_player_stats")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical `AlbionBB` battle id. Unconstrained, matching
        /// `battle_guild_stats.battle_id`.
        pub battle_id: i64,
        /// Opaque identity key the caller computes — `"id:<albion id>"` when
        /// the payload carried a player id, `"name:<lowercased name>"`
        /// otherwise. The battle-detail player list frequently omits `id`,
        /// so this is the reliable dedupe/uniqueness key, not `player_id`.
        pub player_key: String,
        /// Raw Albion player id, when the payload had one.
        pub player_id: Option<String>,
        /// Player display name.
        pub player_name: String,
        /// How `player_key` was derived: `"player_id"` or `"name_only"`.
        /// Plain text, not an enum/check constraint.
        pub identity_source: String,
        /// Albion guild id the player belonged to in this battle.
        pub guild_id: String,
        /// Guild display name.
        pub guild_name: String,
        /// Alliance display name, when present.
        pub alliance_name: Option<String>,
        /// Whether this is a member of the configured guild.
        pub is_friendly: bool,
        /// Kills landed by this player in the battle.
        pub kills: i32,
        /// Deaths suffered by this player in the battle.
        pub deaths: i32,
        /// Total fame earned by this player's kills.
        pub kill_fame: i64,
        /// Total fame lost on this player's deaths.
        pub death_fame: i64,
        /// This player's item power, as observed in the battle.
        pub item_power: f64,
        /// Raw upstream item type id of the player's main-hand weapon, when
        /// observed.
        pub main_hand_item_id: Option<String>,
        /// Assigned combat role, when classified.
        pub role: Option<String>,
        /// Confidence behind `role`: `"curated"`, `"heuristic"` or
        /// `"unobserved"`. Plain text, not an enum/check constraint.
        pub role_confidence: Option<String>,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod battle_kill {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One row per kill event observed while hydrating a battle.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_kills")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Which battle *this hydration run* attributed the kill to.
        /// Unconstrained, matching `battle_guild_stats.battle_id`.
        pub battle_id: i64,
        /// `AlbionBB` kill event id. Globally unique across the whole game,
        /// not just within one battle — this is the column that lets a kill
        /// seen in two overlapping battle segments be deduplicated.
        pub source_event_id: i64,
        /// When the kill occurred.
        pub occurred_at: DateTimeWithTimeZone,
        /// Opaque identity key of the killer, in the same shape as
        /// `battle_player_stats.player_key`.
        pub killer_player_key: String,
        /// Killer display name.
        pub killer_name: String,
        /// Killer's guild id, when the payload carried one.
        pub killer_guild_id: Option<String>,
        /// Killer's guild display name.
        pub killer_guild_name: Option<String>,
        /// Opaque identity key of the victim, in the same shape as
        /// `battle_player_stats.player_key`.
        pub victim_player_key: String,
        /// Victim display name.
        pub victim_name: String,
        /// Victim's guild id, when the payload carried one.
        pub victim_guild_id: Option<String>,
        /// Victim's guild display name.
        pub victim_guild_name: Option<String>,
        /// Killer's item power at the time of the kill.
        pub killer_item_power: f64,
        /// Victim's item power at the time of the kill.
        pub victim_item_power: f64,
        /// Total fame awarded for this kill.
        pub total_kill_fame: i64,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        KillItems,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::KillItems => Entity::has_many(super::battle_kill_item::Entity).into(),
            }
        }
    }

    impl Related<super::battle_kill_item::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::KillItems.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod battle_kill_item {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One row per victim item stack observed in a kill's equipment.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_kill_items")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The kill this item was equipped in. A real foreign key, unlike
        /// the other three tables' `battle_id`, because `battle_kills` is a
        /// table we own rather than an upstream identifier.
        pub kill_id: i64,
        /// Upstream equipment slot key, stored verbatim (e.g. `"MainHand"`,
        /// `"Head"`, `"Armor"`).
        pub slot: String,
        /// Raw upstream item type string, stored verbatim (e.g.
        /// `"T8_2H_HOLYSTAFF_MORGANA@3"`).
        pub item_type_id: String,
        /// Stack size of this item.
        pub quantity: i32,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        BattleKill,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::BattleKill => Entity::belongs_to(super::battle_kill::Entity)
                    .from(Column::KillId)
                    .to(super::battle_kill::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::battle_kill::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::BattleKill.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
