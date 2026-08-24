//! Clean public-facing types for the `battles` module.
//!
//! These are reshaped from the raw AlbionBB payload into snake_case types
//! consistent with the rest of the codebase. Missing upstream fields fall back
//! to safe defaults so the frontend never has to handle nulls.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::modules::albionbb::client::{
    AlbionBbBattleDetail, AlbionBbBattleSummary, AlbionBbGuild, AlbionBbKillEvent, AlbionBbPlayer,
};

/// A guild summary nested in a battle.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattleGuildSummary {
    /// Guild id.
    pub id: String,
    /// Guild name.
    pub name: String,
    /// Players from this guild.
    pub players: i64,
    /// Kills by this guild.
    pub kills: i64,
    /// Deaths by this guild.
    pub deaths: i64,
    /// Kill fame.
    pub kill_fame: i64,
    /// `true` if this guild won.
    pub winner: bool,
}

/// A battle summary for list views.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattleSummary {
    /// AlbionBB battle id.
    pub battle_id: i64,
    /// ISO 8601 start time.
    pub start_time: String,
    /// ISO 8601 end time (may equal start time when unknown).
    pub end_time: String,
    /// Total players across all guilds.
    pub total_players: i64,
    /// Total kills in the battle.
    pub total_kills: i64,
    /// Total fame generated.
    pub total_fame: i64,
    /// Per-guild breakdown (includes opponents).
    pub guilds: Vec<BattleGuildSummary>,
}

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
}

/// A kill participant (killer or victim).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattleKillParticipant {
    /// Player id.
    pub id: String,
    /// Player name.
    pub name: String,
    /// Guild id, if known.
    pub guild_id: Option<String>,
    /// Guild name, if known.
    pub guild_name: Option<String>,
}

/// A kill event in the battle timeline.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattleKillEvent {
    /// AlbionBB kill event id.
    pub event_id: i64,
    /// ISO 8601 kill time.
    pub time: String,
    /// The killer.
    pub killer: BattleKillParticipant,
    /// The victim.
    pub victim: BattleKillParticipant,
    /// Killer average item power.
    pub killer_item_power: f64,
    /// Victim average item power.
    pub victim_item_power: f64,
    /// Total fame awarded for this kill.
    pub total_kill_fame: i64,
    /// The entire upstream kill event preserved verbatim, so the frontend can
    /// render any AlbionBB field we did not model explicitly.
    pub raw: serde_json::Value,
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

/// Full battle detail, extending the summary with per-player and kill timeline.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BattleDetail {
    /// All summary fields inlined.
    #[serde(flatten)]
    pub summary: BattleSummary,
    /// Per-player breakdown.
    pub players: Vec<BattlePlayer>,
    /// Kill timeline (newest last, as returned by AlbionBB).
    pub kills: Vec<BattleKillEvent>,
    /// Market-based loss estimate from victim equipment, when Albion Data is reachable.
    pub estimated_losses: BattleLossEstimate,
    /// The guild event this battle was fought under, when it was linked to one.
    ///
    /// AlbionBB knows nothing about our events, so this is resolved locally.
    /// Its absence is meaningful rather than missing data: a battle with no
    /// event was picked up by the background sync and cannot be attributed to
    /// a composition.
    pub linked_event: Option<LinkedEvent>,
}

/// The event a battle belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LinkedEvent {
    /// Event id, for linking through to it.
    pub id: i64,
    /// Event title.
    pub title: String,
    /// Whether the event was a call-to-arms, which is what entitles regears.
    pub call_to_arms: bool,
}

impl From<&AlbionBbGuild> for BattleGuildSummary {
    fn from(g: &AlbionBbGuild) -> Self {
        Self {
            id: g.id.clone(),
            name: g.name.clone(),
            players: g.players,
            kills: g.kills,
            deaths: g.deaths,
            kill_fame: g.kill_fame,
            winner: g.winner,
        }
    }
}

impl From<&AlbionBbBattleSummary> for BattleSummary {
    fn from(s: &AlbionBbBattleSummary) -> Self {
        let max_kill_fame = s.guilds.iter().map(|g| g.kill_fame).max().unwrap_or(0);
        let guilds = s
            .guilds
            .iter()
            .map(|g| BattleGuildSummary {
                winner: g.winner || g.kill_fame == max_kill_fame,
                ..BattleGuildSummary::from(g)
            })
            .collect();

        Self {
            battle_id: s.id,
            start_time: s.start_time.clone(),
            end_time: if s.end_time.is_empty() {
                s.start_time.clone()
            } else {
                s.end_time.clone()
            },
            total_players: s.total_players,
            total_kills: s.total_kills,
            total_fame: s.total_fame,
            guilds,
        }
    }
}

impl From<AlbionBbBattleSummary> for BattleSummary {
    fn from(s: AlbionBbBattleSummary) -> Self {
        Self::from(&s)
    }
}

impl From<&AlbionBbPlayer> for BattlePlayer {
    fn from(p: &AlbionBbPlayer) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            guild_id: p.guild_id.clone(),
            guild_name: p.guild_name.clone(),
            kills: p.kills,
            deaths: p.deaths,
            kill_fame: p.kill_fame,
            death_fame: p.death_fame,
            item_power: p.item_power,
        }
    }
}

impl From<&AlbionBbKillEvent> for BattleKillEvent {
    fn from(e: &AlbionBbKillEvent) -> Self {
        Self {
            event_id: e.event_id,
            time: e.time.clone(),
            killer: BattleKillParticipant {
                id: e.killer.id.clone(),
                name: e.killer.name.clone(),
                guild_id: e.killer.guild_id.clone(),
                guild_name: e.killer.guild_name.clone(),
            },
            victim: BattleKillParticipant {
                id: e.victim.id.clone(),
                name: e.victim.name.clone(),
                guild_id: e.victim.guild_id.clone(),
                guild_name: e.victim.guild_name.clone(),
            },
            killer_item_power: e.killer_item_power,
            victim_item_power: e.victim_item_power,
            total_kill_fame: e.total_kill_fame,
            raw: e.raw.clone(),
        }
    }
}

/// Builds a [`BattleDetail`] from a battle detail + its kills.
impl BattleDetail {
    /// Composes a `BattleDetail` from the upstream battle payload and kill feed.
    pub fn from_upstream(detail: &AlbionBbBattleDetail, kills: &[AlbionBbKillEvent]) -> Self {
        Self {
            summary: BattleSummary::from(&detail.summary),
            players: detail.players.iter().map(BattlePlayer::from).collect(),
            kills: kills.iter().map(BattleKillEvent::from).collect(),
            estimated_losses: BattleLossEstimate::default(),
            linked_event: None,
        }
    }
}
