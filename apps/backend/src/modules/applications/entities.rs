//! SeaORM entity for Discord applications.

use sea_orm::entity::prelude::*;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize)]
#[sea_orm(table_name = "discord_applications")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub user_discord_id: String,
    pub user_id: Option<i64>,
    pub username_snapshot: String,
    pub channel_id: String,
    pub status: String,
    pub created_at: DateTimeWithTimeZone,
    pub resolved_at: Option<DateTimeWithTimeZone>,
    pub resolved_by_discord_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
