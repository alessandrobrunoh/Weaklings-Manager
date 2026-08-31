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
    /// Alliance name, if in an alliance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_name: Option<String>,
    /// Alliance id, if in an alliance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_id: Option<String>,
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
    /// Average item power of guild members.
    #[serde(default)]
    pub average_item_power: f64,
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
    /// Alliance name, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_name: Option<String>,
    /// Alliance id, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alliance_id: Option<String>,
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
            alliance_name: g.alliance_name.clone(),
            alliance_id: g.alliance_id.clone(),
            players: g.players,
            kills: g.kills,
            deaths: g.deaths,
            kill_fame: g.kill_fame,
            winner: g.winner,
            average_item_power: g.average_item_power,
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
            alliance_name: p.alliance_name.clone(),
            alliance_id: p.alliance_id.clone(),
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
                alliance_name: e.killer.alliance_name.clone(),
                alliance_id: e.killer.alliance_id.clone(),
            },
            victim: BattleKillParticipant {
                id: e.victim.id.clone(),
                name: e.victim.name.clone(),
                guild_id: e.victim.guild_id.clone(),
                guild_name: e.victim.guild_name.clone(),
                alliance_name: e.victim.alliance_name.clone(),
                alliance_id: e.victim.alliance_id.clone(),
            },
            killer_item_power: e.killer_item_power,
            victim_item_power: e.victim_item_power,
            total_kill_fame: e.total_kill_fame,
            raw: e.raw.clone(),
        }
    }
}

fn extract_alliance_from_json(value: &serde_json::Value) -> Option<String> {
    for key in &[
        "Alliance",
        "alliance",
        "AllianceName",
        "allianceName",
        "AllianceTag",
        "allianceTag",
        "alliance_name",
        "alliance_tag",
        "Alliance_Name",
        "Alliance_Tag",
        "Tag",
        "tag",
    ] {
        if let Some(val) = value.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_alliance_id_from_json(value: &serde_json::Value) -> Option<String> {
    for key in &["AllianceId", "allianceId", "alliance_id", "Alliance_Id"] {
        if let Some(val) = value.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

impl BattleSummary {
    /// Composes a `BattleSummary` from a full battle detail, cross-hydrating guild alliances
    /// from player records and raw kill event payloads.
    pub fn from_detail(detail: &AlbionBbBattleDetail) -> Self {
        let mut summary = Self::from(&detail.summary);
        let mut guild_to_alliance: std::collections::HashMap<String, (String, Option<String>)> =
            std::collections::HashMap::new();

        // 1. Seed from summary guilds
        for g in &detail.summary.guilds {
            if let Some(ally) = g.alliance_name.as_ref().filter(|s| !s.trim().is_empty()) {
                guild_to_alliance.insert(
                    g.name.to_lowercase(),
                    (ally.trim().to_string(), g.alliance_id.clone()),
                );
            }
        }

        // 2. Seed from players
        for p in &detail.players {
            if let Some(ally) = p.alliance_name.as_ref().filter(|s| !s.trim().is_empty()) {
                if !p.guild_name.trim().is_empty() {
                    guild_to_alliance
                        .entry(p.guild_name.to_lowercase())
                        .or_insert_with(|| (ally.trim().to_string(), p.alliance_id.clone()));
                }
            }
        }

        // Apply cross-hydrated alliances to all guilds
        for g in &mut summary.guilds {
            if g.alliance_name
                .as_ref()
                .map_or(true, |s| s.trim().is_empty())
            {
                if let Some((ally_name, ally_id)) = guild_to_alliance.get(&g.name.to_lowercase()) {
                    g.alliance_name = Some(ally_name.clone());
                    if g.alliance_id.is_none() {
                        g.alliance_id = ally_id.clone();
                    }
                }
            }
        }

        summary
    }
}

/// Builds a [`BattleDetail`] from a battle detail + its kills with complete alliance cross-hydration.
impl BattleDetail {
    /// Composes a `BattleDetail` from the upstream battle payload and kill feed.
    pub fn from_upstream(detail: &AlbionBbBattleDetail, kills: &[AlbionBbKillEvent]) -> Self {
        let mut guild_to_alliance: std::collections::HashMap<String, (String, Option<String>)> =
            std::collections::HashMap::new();

        // 1. Seed from summary guilds
        for g in &detail.summary.guilds {
            if let Some(ally) = g.alliance_name.as_ref().filter(|s| !s.trim().is_empty()) {
                guild_to_alliance.insert(
                    g.name.to_lowercase(),
                    (ally.trim().to_string(), g.alliance_id.clone()),
                );
            }
        }

        // 2. Seed from players
        for p in &detail.players {
            if let Some(ally) = p.alliance_name.as_ref().filter(|s| !s.trim().is_empty()) {
                if !p.guild_name.trim().is_empty() {
                    guild_to_alliance
                        .entry(p.guild_name.to_lowercase())
                        .or_insert_with(|| (ally.trim().to_string(), p.alliance_id.clone()));
                }
            }
        }

        // 3. Seed from kills & raw JSON payloads
        for k in kills {
            if let Some(guild) = &k.killer.guild_name {
                if let Some(ally) = k
                    .killer
                    .alliance_name
                    .as_ref()
                    .filter(|s| !s.trim().is_empty())
                {
                    guild_to_alliance
                        .entry(guild.to_lowercase())
                        .or_insert_with(|| (ally.trim().to_string(), k.killer.alliance_id.clone()));
                }
            }
            if let Some(guild) = &k.victim.guild_name {
                if let Some(ally) = k
                    .victim
                    .alliance_name
                    .as_ref()
                    .filter(|s| !s.trim().is_empty())
                {
                    guild_to_alliance
                        .entry(guild.to_lowercase())
                        .or_insert_with(|| (ally.trim().to_string(), k.victim.alliance_id.clone()));
                }
            }

            // Inspect nested raw Killer
            if let Some(killer_val) = k.raw.get("Killer").or_else(|| k.raw.get("killer")) {
                let guild = killer_val
                    .get("GuildName")
                    .or_else(|| killer_val.get("guildName"))
                    .and_then(|v| v.as_str());
                if let Some(g) = guild.filter(|s| !s.trim().is_empty()) {
                    if let Some(ally) = extract_alliance_from_json(killer_val) {
                        let ally_id = extract_alliance_id_from_json(killer_val);
                        guild_to_alliance
                            .entry(g.to_lowercase())
                            .or_insert_with(|| (ally, ally_id));
                    }
                }
            }

            // Inspect nested raw Victim
            if let Some(victim_val) = k.raw.get("Victim").or_else(|| k.raw.get("victim")) {
                let guild = victim_val
                    .get("GuildName")
                    .or_else(|| victim_val.get("guildName"))
                    .and_then(|v| v.as_str());
                if let Some(g) = guild.filter(|s| !s.trim().is_empty()) {
                    if let Some(ally) = extract_alliance_from_json(victim_val) {
                        let ally_id = extract_alliance_id_from_json(victim_val);
                        guild_to_alliance
                            .entry(g.to_lowercase())
                            .or_insert_with(|| (ally, ally_id));
                    }
                }
            }

            // Inspect nested raw GroupMembers / Participants
            let participants = k
                .raw
                .get("GroupMembers")
                .or_else(|| k.raw.get("groupMembers"))
                .or_else(|| k.raw.get("Participants"))
                .or_else(|| k.raw.get("participants"))
                .and_then(|v| v.as_array());
            if let Some(members) = participants {
                for member in members {
                    let guild = member
                        .get("GuildName")
                        .or_else(|| member.get("guildName"))
                        .and_then(|v| v.as_str());
                    if let Some(g) = guild.filter(|s| !s.trim().is_empty()) {
                        if let Some(ally) = extract_alliance_from_json(member) {
                            let ally_id = extract_alliance_id_from_json(member);
                            guild_to_alliance
                                .entry(g.to_lowercase())
                                .or_insert_with(|| (ally, ally_id));
                        }
                    }
                }
            }
        }

        // Cross-hydrate summary guilds
        let mut summary = BattleSummary::from(&detail.summary);
        for g in &mut summary.guilds {
            if g.alliance_name
                .as_ref()
                .map_or(true, |s| s.trim().is_empty())
            {
                if let Some((ally_name, ally_id)) = guild_to_alliance.get(&g.name.to_lowercase()) {
                    g.alliance_name = Some(ally_name.clone());
                    if g.alliance_id.is_none() {
                        g.alliance_id = ally_id.clone();
                    }
                }
            }
        }

        // Cross-hydrate players
        let mut players: Vec<BattlePlayer> =
            detail.players.iter().map(BattlePlayer::from).collect();
        for p in &mut players {
            if p.alliance_name
                .as_ref()
                .map_or(true, |s| s.trim().is_empty())
            {
                if let Some((ally_name, ally_id)) =
                    guild_to_alliance.get(&p.guild_name.to_lowercase())
                {
                    p.alliance_name = Some(ally_name.clone());
                    if p.alliance_id.is_none() {
                        p.alliance_id = ally_id.clone();
                    }
                }
            }
        }

        // Cross-hydrate kills
        let mut kills: Vec<BattleKillEvent> = kills.iter().map(BattleKillEvent::from).collect();
        for k in &mut kills {
            if let Some(g) = &k.killer.guild_name {
                if k.killer
                    .alliance_name
                    .as_ref()
                    .map_or(true, |s| s.trim().is_empty())
                {
                    if let Some((ally_name, ally_id)) = guild_to_alliance.get(&g.to_lowercase()) {
                        k.killer.alliance_name = Some(ally_name.clone());
                        if k.killer.alliance_id.is_none() {
                            k.killer.alliance_id = ally_id.clone();
                        }
                    }
                }
            }
            if let Some(g) = &k.victim.guild_name {
                if k.victim
                    .alliance_name
                    .as_ref()
                    .map_or(true, |s| s.trim().is_empty())
                {
                    if let Some((ally_name, ally_id)) = guild_to_alliance.get(&g.to_lowercase()) {
                        k.victim.alliance_name = Some(ally_name.clone());
                        if k.victim.alliance_id.is_none() {
                            k.victim.alliance_id = ally_id.clone();
                        }
                    }
                }
            }
        }

        Self {
            summary,
            players,
            kills,
            estimated_losses: BattleLossEstimate::default(),
            linked_event: None,
        }
    }
}
