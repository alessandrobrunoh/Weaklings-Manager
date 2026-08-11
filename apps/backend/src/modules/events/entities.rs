//! Sea-ORM entities for the events module tables.
//!
//! Two tables: events, event_participations.

pub mod event {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "events")]
    pub struct Model {
        /// The unique primary key of the event.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The title of the event.
        pub title: String,
        /// A description of the event.
        pub description: Option<String>,
        /// Whether this event is a priority call-to-arms announcement.
        pub call_to_arms: bool,
        /// The composition associated with this event.
        pub comp_id: i64,
        /// The user who created the event.
        pub created_by: i64,
        /// The timestamp when the event will start (UTC).
        pub event_date_utc: DateTimeWithTimeZone,
        /// The timestamp when the event was created.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the event was last updated.
        pub updated_at: DateTimeWithTimeZone,
        /// The session status of the event.
        pub status: String,
        /// The timestamp when the event session started.
        pub started_at: Option<DateTimeWithTimeZone>,
        /// The timestamp when the event session stopped.
        pub stopped_at: Option<DateTimeWithTimeZone>,
        /// The deadline for automatic session stop.
        pub auto_stop_deadline: Option<DateTimeWithTimeZone>,
        /// The status of the link process.
        pub link_status: String,
        /// The number of link attempts made.
        pub link_attempts: i64,
        /// The last error encountered during linking.
        pub link_last_error: Option<String>,
        /// The timestamp when battle linking completed.
        pub link_battles_completed_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Comp,
        Creator,
        Participations,
        EventBattles,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Comp => Entity::belongs_to(crate::modules::comps::entities::comp::Entity)
                    .from(Column::CompId)
                    .to(crate::modules::comps::entities::comp::Column::Id)
                    .into(),
                Self::Creator => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::CreatedBy)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::Participations => Entity::has_many(super::event_participation::Entity).into(),
                Self::EventBattles => Entity::has_many(super::event_battle::Entity).into(),
            }
        }
    }

    impl Related<crate::modules::comps::entities::comp::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Comp.def()
        }
    }

    impl Related<crate::modules::users::entities::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Creator.def()
        }
    }

    impl Related<super::event_participation::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Participations.def()
        }
    }

    impl Related<super::event_battle::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::EventBattles.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod event_participation {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "event_participations")]
    pub struct Model {
        /// The unique primary key of the participation entry.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The event ID.
        pub event_id: i64,
        /// The user participating in the event.
        pub user_id: i64,
        /// The primary build chosen by the participant.
        pub primary_build_id: i64,
        /// The optional secondary build chosen by the participant.
        pub secondary_build_id: Option<i64>,
        /// The timestamp when the participant signed up.
        pub created_at: DateTimeWithTimeZone,
        /// The timestamp when the participation was last updated.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Event,
        User,
        PrimaryBuild,
        SecondaryBuild,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Event => Entity::belongs_to(super::event::Entity)
                    .from(Column::EventId)
                    .to(super::event::Column::Id)
                    .into(),
                Self::User => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::UserId)
                    .to(crate::modules::users::entities::Column::Id)
                    .into(),
                Self::PrimaryBuild => {
                    Entity::belongs_to(crate::modules::comps::entities::build::Entity)
                        .from(Column::PrimaryBuildId)
                        .to(crate::modules::comps::entities::build::Column::Id)
                        .into()
                }
                Self::SecondaryBuild => {
                    Entity::belongs_to(crate::modules::comps::entities::build::Entity)
                        .from(Column::SecondaryBuildId)
                        .to(crate::modules::comps::entities::build::Column::Id)
                        .into()
                }
            }
        }
    }

    impl Related<super::event::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Event.def()
        }
    }

    impl Related<crate::modules::users::entities::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::User.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod event_battle {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "event_battles")]
    pub struct Model {
        /// The unique primary key of the event battle entry.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// The event ID.
        pub event_id: i64,
        /// The Albion Battle Builder battle ID.
        pub albionbb_battle_id: String,
        /// The timestamp when the battle started.
        pub battle_started_at: DateTimeWithTimeZone,
        /// The number of guild players in the battle.
        pub guild_players_count: i32,
        /// The total number of players in the battle.
        pub battle_total_players: Option<i32>,
        /// The timestamp when this battle was fetched.
        pub fetched_at: DateTimeWithTimeZone,
        /// Kills scored by the configured guild.
        pub guild_kills: i64,
        /// Deaths suffered by the configured guild.
        pub guild_deaths: i64,
        /// Kill fame scored by the configured guild.
        pub guild_kill_fame: i64,
        /// Whether the configured guild won this battle.
        pub is_win: bool,
        /// Main opponent guild ID by kill fame, if known.
        pub opponent_guild_id: Option<String>,
        /// Main opponent guild name by kill fame, if known.
        pub opponent_guild_name: Option<String>,
        /// Main opponent player count, if known.
        pub opponent_players_count: Option<i32>,
        /// Main opponent kills, if known.
        pub opponent_kills: Option<i64>,
        /// Main opponent deaths, if known.
        pub opponent_deaths: Option<i64>,
        /// Main opponent kill fame, if known.
        pub opponent_kill_fame: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Event,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Event => Entity::belongs_to(super::event::Entity)
                    .from(Column::EventId)
                    .to(super::event::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::event::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Event.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
