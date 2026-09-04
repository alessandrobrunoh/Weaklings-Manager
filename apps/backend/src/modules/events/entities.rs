//! Sea-ORM entities for the events module tables.
//!
//! Event tables, including persisted participants and extra roster roles.

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
        /// Whether this event enables automatic and manual regear processing.
        pub regear: bool,
        /// The composition associated with the event.
        pub comp_id: i64,
        /// Optional signup threshold that advances to the next comp expansion without blocking signups.
        pub player_cap: Option<i64>,
        /// The user who created the event.
        pub created_by: i64,
        /// Compatibility alias for `start_time_utc` (UTC).
        pub event_date_utc: DateTimeWithTimeZone,
        /// The time at which the mass is announced (UTC).
        pub mass_time_utc: Option<DateTimeWithTimeZone>,
        /// The time at which the event starts automatically (UTC).
        pub start_time_utc: Option<DateTimeWithTimeZone>,
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
        /// Discord voice channel created for the live event, if any.
        pub discord_voice_channel_id: Option<String>,
        /// Monotonically increasing revision of persisted roster assignments.
        pub roster_version: i64,
        /// When this event was archived. `None` means it is listed as active.
        pub archived_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Comp,
        Creator,
        Participations,
        EventBattles,
        DiscordRoles,
        RosterRoles,
        RosterAssignments,
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
                Self::DiscordRoles => Entity::has_many(super::event_discord_role::Entity).into(),
                Self::RosterRoles => Entity::has_many(super::event_roster_role::Entity).into(),
                Self::RosterAssignments => {
                    Entity::has_many(super::event_roster_assignment::Entity).into()
                }
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

    impl Related<super::event_discord_role::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::DiscordRoles.def()
        }
    }

    impl Related<super::event_roster_role::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::RosterRoles.def()
        }
    }

    impl Related<super::event_roster_assignment::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::RosterAssignments.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod event_roster_assignment {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "event_roster_assignments")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub event_id: i64,
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: i64,
        pub seat_key: String,
        pub assigned_by: i64,
        pub assigned_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Event,
        User,
        Assigner,
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
                Self::Assigner => Entity::belongs_to(crate::modules::users::entities::Entity)
                    .from(Column::AssignedBy)
                    .to(crate::modules::users::entities::Column::Id)
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

pub mod event_discord_role {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "event_discord_roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub event_id: i64,
        #[sea_orm(primary_key, auto_increment = false)]
        pub discord_role_id: String,
        pub sort_order: i32,
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

pub mod event_roster_role {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "event_roster_roles")]
    pub struct Model {
        /// The unique persisted role ID.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Event that owns this extra role.
        pub event_id: i64,
        /// Existing build exposed as this extra roster role.
        pub build_id: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Event,
        Build,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Event => Entity::belongs_to(super::event::Entity)
                    .from(Column::EventId)
                    .to(super::event::Column::Id)
                    .into(),
                Self::Build => Entity::belongs_to(crate::modules::comps::entities::build::Entity)
                    .from(Column::BuildId)
                    .to(crate::modules::comps::entities::build::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::event::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Event.def()
        }
    }

    impl Related<crate::modules::comps::entities::build::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Build.def()
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
        /// The primary build chosen by the participant, or `None` for the virtual `Fill` role.
        pub primary_build_id: Option<i64>,
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

pub mod fight {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "fights")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub event_id: Option<i64>,
        pub started_at: DateTimeWithTimeZone,
        pub ended_at: Option<DateTimeWithTimeZone>,
        pub grouping_method: String,
        pub grouping_confidence: f64,
        pub grouping_version: String,
        pub needs_review: bool,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Event,
        Segments,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Event => Entity::belongs_to(super::event::Entity)
                    .from(Column::EventId)
                    .to(super::event::Column::Id)
                    .into(),
                Self::Segments => Entity::has_many(super::fight_battle::Entity).into(),
            }
        }
    }

    impl Related<super::event::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Event.def()
        }
    }

    impl Related<super::fight_battle::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Segments.def()
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod fight_battle {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "fight_battles")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub fight_id: i64,
        pub battle_id: i64,
        pub sequence_number: i32,
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Fight,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Fight => Entity::belongs_to(super::fight::Entity)
                    .from(Column::FightId)
                    .to(super::fight::Column::Id)
                    .into(),
            }
        }
    }

    impl Related<super::fight::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Fight.def()
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
