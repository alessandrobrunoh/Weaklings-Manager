//! `SeaORM` entity for persisted guild battle snapshots.
//!
//! The snapshot stores hydrated `AlbionBB` data as JSON strings because the app needs a stable local
//! analytics source even when upstream payloads evolve. Service code owns serialization so the DB
//! remains portable across supported SQL backends.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

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

/// A player in a battle.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattlePlayer {
    /// Player id.
    pub id: String,
    /// Player name.
    pub name: String,
    /// Guild id.
    pub guild_id: String,
    /// Guild name.
    pub guild_name: String,
    /// Alliance name, if in an alliance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_name: Option<String>,
    /// Alliance id, if in an alliance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_id: Option<String>,
    /// Kills.
    pub kills: i64,
    /// Deaths.
    pub deaths: i64,
    /// Kill fame.
    pub kill_fame: i64,
    /// Death fame.
    pub death_fame: i64,
    /// Average item power.
    pub item_power: f64,
    /// `true` when the player's guild fights on the requesting tenant's side.
    /// Stamped by the backend on read; see [`BattleGuildSummary::is_friendly`].
    #[serde(default)]
    pub is_friendly: bool,
}

/// Estimated silver lost in a battle, derived from victim equipment and Albion Data prices.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct BattleLossEstimate {
    /// Sum of all priced victim equipment items.
    pub total_estimated_loss: i64,
    /// Number of distinct item stacks that received a market price.
    pub priced_items: i64,
    /// Number of item stacks present in kill feed equipment.
    pub total_items: i64,
    /// Estimate grouped by victim player.
    pub players: Vec<PlayerLossEstimate>,
    /// Estimate grouped by victim guild.
    pub guilds: Vec<GuildLossEstimate>,
}

/// Per-player loss estimate for one battle.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct PlayerLossEstimate {
    pub player_name: String,
    pub guild_name: Option<String>,
    pub estimated_loss: i64,
    pub deaths: i64,
    pub priced_items: i64,
    pub total_items: i64,
}

/// Per-guild loss estimate for one battle.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct GuildLossEstimate {
    pub guild_name: String,
    pub estimated_loss: i64,
    pub deaths: i64,
    pub priced_items: i64,
    pub total_items: i64,
}
