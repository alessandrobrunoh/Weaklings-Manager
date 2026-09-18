//! SeaORM entity for the `trials` table.

use sea_orm::entity::prelude::*;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize)]
#[sea_orm(table_name = "trials")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    /// Discord snowflake of the trialing member.
    pub discord_id: String,
    /// Local web account, when the member has one.
    pub user_id: Option<i64>,
    /// Application ticket this trial came from, when it started through one.
    pub application_id: Option<i64>,
    /// Discord username at trial start; members may rename later.
    pub username_snapshot: String,
    /// Albion character given in the application, when known.
    pub ingame_name: Option<String>,
    pub started_at: DateTimeWithTimeZone,
    /// When the trial is due; remaining time is derived, never stored.
    pub ends_at: DateTimeWithTimeZone,
    /// `active` until a manager converts or removes the member.
    pub status: String,
    /// Manager who accepted the application, when it started through one.
    pub created_by_discord_id: Option<String>,
    pub ended_at: Option<DateTimeWithTimeZone>,
    /// Manager who converted or removed the member.
    pub ended_by_discord_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
