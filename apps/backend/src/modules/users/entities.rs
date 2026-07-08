//! Sea-ORM entity for the `users` table.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "users")]
pub struct Model {
    /// The unique primary key of the user.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// The username of the user.
    pub username: String,
    /// The unique email address of the user.
    #[sea_orm(unique)]
    pub email: String,
    /// The system authorization role of the user.
    pub role: String,
    /// The Discord snowflake ID this user last logged in with, if any. Bridges to
    /// `albion_links.discord_id` so a linked Albion Online character name can be resolved
    /// back to this user.
    #[sea_orm(unique)]
    pub discord_id: Option<String>,
    /// The timestamp when the user was created.
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
