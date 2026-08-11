//! SeaORM entity for persisted guild battle snapshots.
//!
//! The snapshot stores hydrated AlbionBB data as JSON strings because the app needs a stable local
//! analytics source even when upstream payloads evolve. Service code owns serialization so the DB
//! remains portable across supported SQL backends.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "guild_battle_snapshots")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub battle_id: i64,
    pub start_time: DateTimeWithTimeZone,
    pub end_time: Option<DateTimeWithTimeZone>,
    pub total_players: i64,
    pub total_kills: i64,
    pub total_fame: i64,
    pub guilds_json: String,
    pub players_json: String,
    pub kills_json: String,
    pub losses_json: String,
    pub fetched_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
