//! Turning battle snapshots into scouted enemy compositions.
//!
//! A snapshot tells us who was in a fight; a scout is what we choose to
//! remember about the enemy side of it. The translation has to work around one
//! hard limitation of the upstream data: `players_json` carries no weapon and
//! no role, only `{name, guild, kills, deaths, fame, item_power}`. Weapons must
//! therefore be recovered from the kill feed, which names only the players who
//! killed or died. In a large fight that is a minority of the enemy force, so
//! every draft records how many players it actually saw a weapon for, and
//! callers must present similarity scores with that caveat attached.
//!
//! Real battles are multi-guild, unlike the single-opponent shape the reference
//! implementation assumed, so one snapshot yields one draft *per opposing
//! guild* rather than one draft overall.

use std::collections::BTreeMap;

use sea_orm::prelude::DateTimeWithTimeZone;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::AppError;
use crate::modules::battles::entities::Model as SnapshotModel;
use crate::modules::battles::models::{BattleGuildSummary, BattleKillEvent, BattlePlayer};
use crate::modules::events::service::BattleLinkingContext;
use crate::modules::intel::entities::scouted_comp;
use crate::modules::intel::roles::{RoleClassifier, RoleConfidence};
use crate::modules::intel::similarity::{fingerprint_of, CompProfile};
use crate::modules::intel::status::IntelScoutCategory;

/// Enemy compositions smaller than this are treated as noise, not a comp.
///
/// A single straggler caught by a roaming party says nothing about how a guild
/// fields a group, and would otherwise create a scout per lone player.
const MIN_ENEMY_PLAYERS: usize = 2;

/// One observed enemy player, as persisted in `scouted_comps.players_json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ScoutedPlayer {
    /// Character name.
    pub name: String,
    /// Role, derived from the main-hand weapon.
    pub role: String,
    /// Main-hand weapon identifier, absent when the player never appeared in
    /// the kill feed.
    pub weapon: Option<String>,
    /// Whether the role came from a curated build or the keyword fallback.
    pub role_inferred: bool,
    /// Average item power reported for this player.
    pub item_power: f64,
}

/// A scouted composition before it is reconciled with what is already stored.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoutDraft {
    /// Suggested display name, "{guild} {category label}".
    pub name: String,
    /// Opponent guild id, when the payload carried one.
    pub opponent_guild_id: Option<String>,
    /// Opponent guild name.
    pub opponent_guild_name: String,
    /// Opponent alliance name. Battle snapshots do not carry alliance data,
    /// so this is always `None` today; the column exists so officers can fill
    /// it in by hand without a migration.
    pub opponent_alliance_name: Option<String>,
    /// Engagement bracket.
    pub category: IntelScoutCategory,
    /// Role and weapon histograms.
    pub profile: CompProfile,
    /// The observed roster.
    pub players: Vec<ScoutedPlayer>,
    /// Mean item power across observed players.
    pub avg_ip: f64,
    /// Number of enemy players observed.
    pub player_count: i64,
    /// How many of them contributed a weapon.
    pub weapon_sample_size: i64,
    /// Canonical dedupe key.
    pub fingerprint: String,
    /// Battle this draft came from.
    pub battle_id: i64,
    /// Battle start time, used as `first_seen_at`.
    pub observed_at: DateTimeWithTimeZone,
}

impl ScoutDraft {
    /// Whether every observed player contributed a weapon.
    ///
    /// When false, the weapon half of any similarity score is computed from a
    /// sample rather than the whole comp.
    #[must_use]
    pub fn has_full_weapon_coverage(&self) -> bool {
        self.weapon_sample_size >= self.player_count
    }
}

/// Reads the main-hand item id out of one side of a raw kill event.
///
/// The upstream payload is preserved verbatim in `BattleKillEvent::raw`, and
/// its casing is inconsistent between endpoints, hence the paired lookups.
/// This deliberately extracts only the weapon: the full-equipment walkers in
/// `regear::pricing` and `battles::service` exist to price every slot, which is
/// a different job with a different output type.
#[must_use]
pub fn main_hand_of(raw: &Value, side: &str) -> Option<String> {
    let lower = side.to_ascii_lowercase();
    let participant = raw.get(side).or_else(|| raw.get(&lower))?;
    let equipment = participant
        .get("Equipment")
        .or_else(|| participant.get("equipment"))?;
    let main_hand = equipment
        .get("MainHand")
        .or_else(|| equipment.get("mainHand"))
        .or_else(|| equipment.get("main_hand"))?;
    let item_id = main_hand
        .get("Type")
        .or_else(|| main_hand.get("type"))
        .and_then(Value::as_str)?;
    let trimmed = item_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Builds a `name -> main-hand item id` index from a battle's kill feed.
///
/// Both sides of every kill are harvested, since a player who died in one
/// exchange may have killed in another. Later observations overwrite earlier
/// ones, which is harmless: a player who swapped weapons mid-fight is recorded
/// as whatever they were last seen holding.
#[must_use]
pub fn weapons_by_player(kills: &[BattleKillEvent]) -> BTreeMap<String, String> {
    let mut weapons = BTreeMap::new();
    for kill in kills {
        if let Some(item) = main_hand_of(&kill.raw, "Killer") {
            weapons.insert(kill.killer.name.clone(), item);
        }
        if let Some(item) = main_hand_of(&kill.raw, "Victim") {
            weapons.insert(kill.victim.name.clone(), item);
        }
    }
    weapons
}

/// Produces one draft per opposing guild present in a battle snapshot.
///
/// Membership of "our side" is decided entirely by [`BattleLinkingContext`],
/// which is built from configuration — the guild name never appears as a
/// literal here. Allied guilds are excluded alongside our own, which is
/// stricter than the reference implementation and avoids scouting our friends.
///
/// Returns an empty vector rather than an error when a battle has no qualifying
/// opponent; that is a normal outcome, not a failure.
pub fn scout_from_snapshot(
    snapshot: &SnapshotModel,
    guild_ctx: &BattleLinkingContext,
    classifier: &RoleClassifier,
) -> Result<Vec<ScoutDraft>, AppError> {
    let players: Vec<BattlePlayer> = parse_json(&snapshot.players_json, "players_json")?;
    let guilds: Vec<BattleGuildSummary> = parse_json(&snapshot.guilds_json, "guilds_json")?;
    let kills: Vec<BattleKillEvent> = parse_json(&snapshot.kills_json, "kills_json")?;

    // Only scout battles we were actually part of. Without our guild in the
    // line-up there is no "us versus them" to record, and downstream matchup
    // tallies would read the absence as a loss.
    let we_were_present = guilds
        .iter()
        .any(|guild| guild.id == guild_ctx.guild_id())
        || players
            .iter()
            .any(|player| player.guild_id == guild_ctx.guild_id());
    if !we_were_present {
        return Ok(Vec::new());
    }

    let weapons = weapons_by_player(&kills);

    // Group enemy players by guild id, falling back to the name when the
    // payload omitted the id.
    let mut grouped: BTreeMap<String, Vec<&BattlePlayer>> = BTreeMap::new();
    for player in &players {
        if guild_ctx.is_friendly_guild(&player.guild_id, &player.guild_name) {
            continue;
        }
        let key = if player.guild_id.trim().is_empty() {
            player.guild_name.trim().to_string()
        } else {
            player.guild_id.clone()
        };
        if key.is_empty() {
            continue;
        }
        grouped.entry(key).or_default().push(player);
    }

    let mut drafts = Vec::new();
    for (key, members) in grouped {
        if members.len() < MIN_ENEMY_PLAYERS {
            continue;
        }
        let guild_name = members
            .iter()
            .map(|player| player.guild_name.trim())
            .find(|name| !name.is_empty())
            .unwrap_or("Unknown")
            .to_string();
        let guild_id = members
            .iter()
            .map(|player| player.guild_id.trim())
            .find(|id| !id.is_empty())
            .map(str::to_string);

        let mut profile = CompProfile::default();
        let mut roster = Vec::with_capacity(members.len());
        let mut weapon_sample = 0i64;
        let mut ip_total = 0.0;

        for player in &members {
            let weapon = weapons.get(&player.name).cloned();
            let (role, confidence) = match weapon.as_deref() {
                Some(item) => {
                    weapon_sample += 1;
                    classifier.classify(item)
                }
                // No kill-feed sighting: contribute to the role histogram as a
                // DPS (the safest default) but never to the weapon histogram,
                // so partial coverage lowers confidence instead of inventing a
                // weapon distribution.
                None => (
                    crate::modules::comps::status::BuildRole::Dps,
                    RoleConfidence::Heuristic,
                ),
            };
            profile.push_player(role.as_str(), weapon.as_deref());
            ip_total += player.item_power;
            roster.push(ScoutedPlayer {
                name: player.name.clone(),
                role: role.as_str().to_string(),
                weapon,
                role_inferred: confidence == RoleConfidence::Heuristic,
                item_power: player.item_power,
            });
        }

        let player_count = members.len() as i64;
        let category = IntelScoutCategory::from_player_count(player_count);
        let avg_ip = if player_count > 0 {
            ip_total / player_count as f64
        } else {
            0.0
        };

        drafts.push(ScoutDraft {
            name: format!("{guild_name} {}", category.label()),
            opponent_guild_id: guild_id.or_else(|| {
                // The grouping key was the id whenever we had one.
                (!key.trim().is_empty() && key != guild_name).then(|| key.clone())
            }),
            opponent_guild_name: guild_name,
            opponent_alliance_name: None,
            category,
            fingerprint: fingerprint_of(&profile.roles, &profile.weapons),
            profile,
            players: roster,
            avg_ip,
            player_count,
            weapon_sample_size: weapon_sample,
            battle_id: snapshot.battle_id,
            observed_at: snapshot.start_time,
        });
    }

    Ok(drafts)
}

/// Deserializes one of the snapshot's JSON columns, naming the column on failure.
fn parse_json<T: for<'de> Deserialize<'de>>(raw: &str, column: &str) -> Result<T, AppError> {
    serde_json::from_str(raw)
        .map_err(|err| AppError::Internal(format!("malformed {column} in battle snapshot: {err}")))
}

/// Decides whether an incoming draft describes a comp we already track.
///
/// An exact fingerprint match is the strong signal. The `(guild, category)`
/// pair is the weaker fallback that makes the library converge instead of
/// sprouting a near-duplicate every time one player swaps weapons — the same
/// two-tier rule the reference implementation used.
#[must_use]
pub fn is_same_comp(existing: &scouted_comp::Model, incoming: &ScoutDraft) -> bool {
    if existing.fingerprint == incoming.fingerprint {
        return true;
    }
    let same_guild = match (&existing.opponent_guild_id, &incoming.opponent_guild_id) {
        (Some(left), Some(right)) => left == right,
        _ => existing
            .opponent_guild_name
            .eq_ignore_ascii_case(&incoming.opponent_guild_name),
    };
    same_guild && existing.category == incoming.category.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> BattleLinkingContext {
        BattleLinkingContext::new("our-guild", &[], &["Friendly".to_string()])
    }

    fn player(name: &str, guild_id: &str, guild_name: &str, ip: f64) -> Value {
        json!({
            "id": format!("p-{name}"),
            "name": name,
            "guild_id": guild_id,
            "guild_name": guild_name,
            "kills": 0,
            "deaths": 0,
            "kill_fame": 0,
            "death_fame": 0,
            "item_power": ip,
        })
    }

    fn kill(victim: &str, victim_weapon: &str, killer: &str, killer_weapon: &str) -> Value {
        json!({
            "event_id": 1,
            "time": "2026-08-01T00:00:00Z",
            "killer": { "id": "k", "name": killer, "guild_id": null, "guild_name": null },
            "victim": { "id": "v", "name": victim, "guild_id": null, "guild_name": null },
            "killer_item_power": 1400.0,
            "victim_item_power": 1300.0,
            "total_kill_fame": 100,
            "raw": {
                "Killer": { "Equipment": { "MainHand": { "Type": killer_weapon } } },
                "Victim": { "Equipment": { "MainHand": { "Type": victim_weapon } } }
            }
        })
    }

    fn snapshot(players: Vec<Value>, guilds: Vec<Value>, kills: Vec<Value>) -> SnapshotModel {
        SnapshotModel {
            id: 1,
            battle_id: 4242,
            start_time: "2026-08-01T00:00:00Z".parse().unwrap(),
            end_time: None,
            total_players: players.len() as i64,
            total_kills: kills.len() as i64,
            total_fame: 0,
            guilds_json: Value::Array(guilds).to_string(),
            players_json: Value::Array(players).to_string(),
            kills_json: Value::Array(kills).to_string(),
            losses_json: "[]".to_string(),
            fetched_at: "2026-08-01T00:00:00Z".parse().unwrap(),
        }
    }

    fn guild(id: &str, name: &str) -> Value {
        json!({
            "id": id, "name": name, "players": 2, "kills": 1,
            "deaths": 1, "kill_fame": 10, "winner": false
        })
    }

    #[test]
    fn extracts_main_hand_from_either_casing() {
        let upper = json!({"Victim": {"Equipment": {"MainHand": {"Type": "T8_2H_BOW"}}}});
        assert_eq!(main_hand_of(&upper, "Victim").as_deref(), Some("T8_2H_BOW"));
        let lower = json!({"victim": {"equipment": {"mainHand": {"type": "T8_2H_BOW"}}}});
        assert_eq!(main_hand_of(&lower, "Victim").as_deref(), Some("T8_2H_BOW"));
    }

    #[test]
    fn missing_or_blank_weapon_yields_none() {
        assert_eq!(main_hand_of(&json!({}), "Victim"), None);
        let blank = json!({"Victim": {"Equipment": {"MainHand": {"Type": "  "}}}});
        assert_eq!(main_hand_of(&blank, "Victim"), None);
    }

    #[test]
    fn scouts_one_draft_per_opposing_guild() {
        let snap = snapshot(
            vec![
                player("UsA", "our-guild", "Weaklings", 1400.0),
                player("UsB", "our-guild", "Weaklings", 1400.0),
                player("EnemyA", "foe-1", "Foe One", 1300.0),
                player("EnemyB", "foe-1", "Foe One", 1500.0),
                player("OtherA", "foe-2", "Foe Two", 1200.0),
                player("OtherB", "foe-2", "Foe Two", 1200.0),
            ],
            vec![guild("our-guild", "Weaklings"), guild("foe-1", "Foe One")],
            vec![kill("EnemyA", "T8_MAIN_HOLYSTAFF", "UsA", "T8_2H_BOW")],
        );
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        assert_eq!(drafts.len(), 2);
        let names: Vec<&str> = drafts
            .iter()
            .map(|d| d.opponent_guild_name.as_str())
            .collect();
        assert!(names.contains(&"Foe One"));
        assert!(names.contains(&"Foe Two"));
    }

    #[test]
    fn allied_and_own_guild_players_are_never_scouted() {
        let snap = snapshot(
            vec![
                player("UsA", "our-guild", "Weaklings", 1400.0),
                player("UsB", "our-guild", "Weaklings", 1400.0),
                player("AllyA", "ally-id", "Friendly", 1400.0),
                player("AllyB", "ally-id", "Friendly", 1400.0),
            ],
            vec![guild("our-guild", "Weaklings")],
            vec![],
        );
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        assert!(drafts.is_empty(), "allies must not be scouted");
    }

    #[test]
    fn lone_enemy_players_are_ignored_as_noise() {
        let snap = snapshot(
            vec![
                player("UsA", "our-guild", "Weaklings", 1400.0),
                player("Straggler", "foe-1", "Foe One", 1000.0),
            ],
            vec![guild("our-guild", "Weaklings")],
            vec![],
        );
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        assert!(drafts.is_empty());
    }

    #[test]
    fn battles_we_did_not_fight_are_skipped() {
        let snap = snapshot(
            vec![
                player("EnemyA", "foe-1", "Foe One", 1300.0),
                player("EnemyB", "foe-1", "Foe One", 1300.0),
            ],
            vec![guild("foe-1", "Foe One")],
            vec![],
        );
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        assert!(drafts.is_empty());
    }

    /// The load-bearing consequence of `players_json` carrying no weapons:
    /// only players seen in the kill feed contribute to the weapon histogram.
    #[test]
    fn weapon_coverage_reflects_kill_feed_only() {
        let snap = snapshot(
            vec![
                player("UsA", "our-guild", "Weaklings", 1400.0),
                player("EnemyA", "foe-1", "Foe One", 1300.0),
                player("EnemyB", "foe-1", "Foe One", 1300.0),
                player("EnemyC", "foe-1", "Foe One", 1300.0),
            ],
            vec![guild("our-guild", "Weaklings")],
            vec![kill("EnemyA", "T8_MAIN_HOLYSTAFF", "UsA", "T8_2H_BOW")],
        );
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        let draft = &drafts[0];
        assert_eq!(draft.player_count, 3);
        assert_eq!(draft.weapon_sample_size, 1);
        assert!(!draft.has_full_weapon_coverage());
        // Roles still cover everyone; weapons only the sampled player.
        assert_eq!(draft.profile.size(), 3);
        assert_eq!(draft.profile.weapons.values().sum::<i64>(), 1);
        assert_eq!(draft.profile.roles.get("healer"), Some(&1));
        assert_eq!(draft.profile.roles.get("dps"), Some(&2));
    }

    #[test]
    fn category_follows_headcount() {
        let mut players = vec![player("UsA", "our-guild", "Weaklings", 1400.0)];
        for i in 0..9 {
            players.push(player(&format!("E{i}"), "foe-1", "Foe One", 1300.0));
        }
        let snap = snapshot(players, vec![guild("our-guild", "Weaklings")], vec![]);
        let drafts = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap();
        assert_eq!(drafts[0].category, IntelScoutCategory::Zvz);
        assert_eq!(drafts[0].name, "Foe One ZvZ");
    }

    #[test]
    fn malformed_json_names_the_offending_column() {
        let mut snap = snapshot(vec![], vec![], vec![]);
        snap.players_json = "{not json".to_string();
        let err = scout_from_snapshot(&snap, &ctx(), &RoleClassifier::default()).unwrap_err();
        assert!(format!("{err}").contains("players_json"), "got: {err}");
    }
}
