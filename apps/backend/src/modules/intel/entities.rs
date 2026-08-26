//! `SeaORM` entities for the intel module.
//!
//! Two related tables, so they are grouped as inner modules the same way
//! `modules::comps::entities` does, rather than as one flat entity file.

pub mod scouted_comp {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "scouted_comps")]
    pub struct Model {
        /// The unique primary key of the scouted comp.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Display name, defaulting to "{guild} {category label}".
        pub name: String,
        /// Albion guild id of the opponent, when the payload carried one.
        pub opponent_guild_id: Option<String>,
        /// Opponent guild name; the dedupe fallback when the id is absent.
        pub opponent_guild_name: String,
        /// Opponent alliance name, when known.
        pub opponent_alliance_name: Option<String>,
        /// Engagement bracket, see `IntelScoutCategory`.
        pub category: String,
        /// Number of enemy players observed in the composition.
        pub player_count: i32,
        /// How many of those players contributed a main-hand weapon.
        ///
        /// Lower than `player_count` whenever the kill feed covered only part
        /// of the enemy force, which is the normal case in large fights.
        pub weapon_sample_size: i32,
        /// Mean item power across the observed enemy players.
        pub avg_ip: f64,
        /// Role histogram, serialized `{"healer":3,...}`.
        pub roles_json: String,
        /// Weapon histogram, serialized `{"2H_BOW":2,...}`.
        pub weapons_json: String,
        /// Observed enemy roster, serialized.
        pub players_json: String,
        /// Canonical dedupe key, see `similarity::fingerprint_of`.
        pub fingerprint: String,
        /// Denormalized count of linked source battles.
        pub source_battle_count: i32,
        /// Denormalized `losses * 2 + player_count`.
        pub threat_score: i32,
        /// Free-form officer notes.
        pub notes: Option<String>,
        /// Whether the scout is archived (hidden but retained).
        pub is_archived: bool,
        /// Earliest source battle start time.
        pub first_seen_at: DateTimeWithTimeZone,
        /// Most recent time the scout was observed or merged.
        pub saved_at: DateTimeWithTimeZone,
        /// Author, or `None` when scouted automatically by the worker.
        pub created_by_user_id: Option<i64>,
        /// The timestamp when the scout was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the scout was last updated.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Battles,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Battles => Entity::has_many(super::scouted_comp_battle::Entity).into(),
            }
        }
    }

    impl Related<super::scouted_comp_battle::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Battles.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod scouted_comp_battle {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "scouted_comp_battles")]
    pub struct Model {
        /// The unique primary key of the link row.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The scouted comp this battle contributed to.
        pub scouted_comp_id: i64,
        /// Canonical AlbionBB battle id, matching
        /// `guild_battle_snapshots.battle_id`.
        ///
        /// `event_battles.albionbb_battle_id` holds the same value as a
        /// string; join across the two in Rust rather than with a SQL cast,
        /// which would be Postgres-only.
        pub battle_id: i64,
        /// When the battle was linked to the scout.
        pub linked_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        ScoutedComp,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::ScoutedComp => Entity::belongs_to(super::scouted_comp::Entity)
                    .from(Column::ScoutedCompId)
                    .to(super::scouted_comp::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::scouted_comp::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::ScoutedComp.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
