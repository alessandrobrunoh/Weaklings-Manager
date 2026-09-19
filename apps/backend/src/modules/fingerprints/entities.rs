//! `SeaORM` entities for the equipment identity tables.
//!
//! Two related tables, grouped as inner modules the same way
//! `modules::battles::evidence_entities` and `modules::enemies::entities` do,
//! rather than as one flat entity file: `fingerprint` and
//! `battle_loadout_observation`. See
//! `m20260908_000007_create_fingerprint_tables` for the full
//! identity-vs-rollup and immutable-match rationale.

pub mod fingerprint {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The canonical, immutable equipment identity row: a set of observed
    /// slot -> base item id pairs, deduplicated across every battle it has
    /// ever been seen in.
    ///
    /// Deliberately carries no derived observation-count rollup — that is
    /// computed at read time from `battle_loadout_observations`. See
    /// `m20260908_000007_create_fingerprint_tables` for why.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "loadout_fingerprints")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical string the caller computes: sorted `"slot:base_item_id"`
        /// pairs joined by `|` (e.g.
        /// `"cape:T4_CAPE|head:T8_HEAD_PLATE_SET1|weapon:2H_HOLYSTAFF"`), over
        /// whichever slots were actually observed. Slot names here are the
        /// build-side lowercase form (`"weapon"`, not `"MainHand"`) — the
        /// caller normalizes observed upstream slot keys before building
        /// this string, so a fingerprint is directly comparable to a build's
        /// own slot map without any further translation.
        pub fingerprint: String,
        /// `"full"` (built from complete victim death equipment) or
        /// `"weapon_only"` (built from just the main-hand item, when the
        /// player was only ever seen in the kill feed as a killer, never as
        /// a victim). Plain text, not an enum/check constraint.
        pub mode: String,
        /// The normalized base weapon item id. A fingerprint always has at
        /// least this; there is no such thing as a fingerprint with zero
        /// slots.
        pub main_hand_base_item_id: String,
        /// Combat role classified from the weapon, same vocabulary as
        /// `battle_player_stats.role` / `enemy_player_battles.role`
        /// elsewhere in this codebase (curated build role, heuristic
        /// fallback, or absent).
        pub primary_role: Option<String>,
        /// The full sorted slot -> base item id map this fingerprint was
        /// derived from, as JSON (e.g. `{"weapon": "2H_HOLYSTAFF", "head":
        /// "T8_HEAD_PLATE_SET1"}`), kept for display/debugging so a UI can
        /// show every matched slot without re-parsing `fingerprint`.
        pub slots_json: String,
        /// The internal build this fingerprint matched, set once by the
        /// matcher at fingerprint-creation time and never updated
        /// afterward, even if the build catalog changes later — an
        /// immutable historical match, by design. Nullable and `ON DELETE
        /// SET NULL`: a fingerprint's identity must survive a build being
        /// deleted from the catalog later.
        pub matched_build_id: Option<i64>,
        /// Which of the matched build's two loadouts matched: `"main"` or
        /// `"swap"` (mirrors `comps::status::BuildLoadout::as_str()`).
        /// `None` when `matched_build_id` is `None`.
        pub matched_build_loadout: Option<String>,
        /// `"matched"` (exactly one build/loadout combination fully
        /// matches, no ties), `"ambiguous"` (two or more combinations tie
        /// for the best match, so none is chosen), or `"unmatched"` (no
        /// combination matches at all). Plain text, not an enum/check
        /// constraint.
        pub match_status: String,
        /// When this fingerprint was first observed.
        pub first_seen_at: DateTimeWithTimeZone,
        /// When this fingerprint was most recently observed.
        pub last_seen_at: DateTimeWithTimeZone,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last mutation of this row.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        MatchedBuild,
        Observations,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::MatchedBuild => {
                    Entity::belongs_to(crate::modules::comps::entities::build::Entity)
                        .from(Column::MatchedBuildId)
                        .to(crate::modules::comps::entities::build::Column::Id)
                        .into()
                }
                Self::Observations => {
                    Entity::has_many(super::battle_loadout_observation::Entity).into()
                }
            }
        }
    }

    impl Related<crate::modules::comps::entities::build::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::MatchedBuild.def()
        }
    }

    impl Related<super::battle_loadout_observation::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Observations.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod battle_loadout_observation {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// The append-only bridge: one row per (battle, player) recording which
    /// fingerprint they wore in that battle — for both our own players and
    /// enemies alike, since equipment identity doesn't care about side;
    /// `is_friendly` just tags which side observed it.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "battle_loadout_observations")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Canonical `AlbionBB` battle id. Deliberately unconstrained (no
        /// foreign key), matching the established idiom already used by
        /// `battle_guild_stats.battle_id` / `battle_player_stats.battle_id`
        /// / `enemy_player_battles.battle_id`, so this evidence survives
        /// independently of any snapshot pruning.
        pub battle_id: i64,
        /// Opaque identity key, same shape as `battle_player_stats.player_key`
        /// (`"id:<albion id>"` or `"name:<lowercased name>"`).
        pub player_key: String,
        /// Whether this observation is of a member of the configured guild
        /// (`true`) or an enemy (`false`).
        pub is_friendly: bool,
        /// The fingerprint this player wore in this battle.
        pub fingerprint_id: i64,
        /// The battle's own time, not row-insertion time, matching the
        /// convention already used by `enemy_player_battles.occurred_at`.
        pub occurred_at: DateTimeWithTimeZone,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Fingerprint,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Fingerprint => Entity::belongs_to(super::fingerprint::Entity)
                    .from(Column::FingerprintId)
                    .to(super::fingerprint::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::fingerprint::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Fingerprint.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
