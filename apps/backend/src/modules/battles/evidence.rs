//! Normalizes one battle's already-parsed `AlbionBB` data into flat row structs.
//!
//! This module is deliberately pure and DB-free: it takes the same
//! [`BattleGuildSummary`], [`BattlePlayer`] and [`BattleKillEvent`] types the
//! rest of `battles` already works with, plus the two policy objects that
//! decide "is this ours" ([`FriendlySide`]) and "what role is this weapon"
//! ([`RoleClassifier`]), and produces [`GuildStatRow`], [`PlayerStatRow`] and
//! [`KillRow`] values shaped to be inserted 1:1 into SQL tables of matching
//! column names. No `SeaORM` entity, migration, or persistence lives here — a
//! later integration step maps [`NormalizedEvidence`] onto real tables.
//!
//! # Player identity
//!
//! `AlbionBB`'s battle-detail player list frequently omits `id` for players
//! who never appear in the kill feed — the same limitation `/battles/me`
//! already lives with by matching on name instead. Rather than reintroduce
//! that ambiguity at every call site, [`player_identity`] gives it one
//! stable, queryable key: `id:<id>` when an id is present, else
//! `name:<lowercased name>`. Every row that needs to identify a player
//! (roster rows and kill participants alike) goes through this single
//! helper, so the fallback is consistent everywhere it matters instead of
//! being reinvented per call site.
//!
use chrono::{DateTime, FixedOffset};
use serde_json::Value;

use crate::modules::battles::models::{BattleGuildSummary, BattleKillEvent, BattlePlayer};
use crate::modules::battles::outcome::FriendlySide;
use crate::modules::intel::roles::{RoleClassifier, RoleConfidence};
use crate::modules::intel::scout::{ROLE_UNOBSERVED, weapons_by_player};

/// One guild's line for one battle, ready for a `battle_guild_stats`-shaped table.
#[derive(Debug, Clone, PartialEq)]
pub struct GuildStatRow {
    /// Guild id.
    pub guild_id: String,
    /// Guild name.
    pub guild_name: String,
    /// Alliance id, when known.
    pub alliance_id: Option<String>,
    /// Alliance name, when known.
    pub alliance_name: Option<String>,
    /// Whether this guild fought on our side.
    pub is_friendly: bool,
    /// Players fielded by this guild.
    pub players: i32,
    /// Kills by this guild.
    pub kills: i32,
    /// Deaths by this guild.
    pub deaths: i32,
    /// Kill fame earned.
    pub kill_fame: i64,
    /// Average item power of guild members.
    pub avg_item_power: f64,
    /// Whether this guild was crowned the winner.
    ///
    /// This is a straight passthrough of [`BattleGuildSummary::winner`], which
    /// is already the crowned value computed by
    /// [`crate::modules::battles::outcome`] — it is not recomputed here.
    pub winner: bool,
}

/// One player's line for one battle, ready for a `battle_player_stats`-shaped table.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerStatRow {
    /// Stable identity key. See the [module docs](self) for the fallback rule.
    pub player_key: String,
    /// Raw player id, when the upstream payload carried one.
    pub player_id: Option<String>,
    /// Player name.
    pub player_name: String,
    /// Which branch of the identity rule produced `player_key`:
    /// `"player_id"` or `"name_only"`.
    pub identity_source: &'static str,
    /// Guild id.
    pub guild_id: String,
    /// Guild name.
    pub guild_name: String,
    /// Alliance name, when known.
    pub alliance_name: Option<String>,
    /// Whether this player fought on our side.
    pub is_friendly: bool,
    /// Kills.
    pub kills: i32,
    /// Deaths.
    pub deaths: i32,
    /// Kill fame earned.
    pub kill_fame: i64,
    /// Death fame lost.
    pub death_fame: i64,
    /// Average item power.
    pub item_power: f64,
    /// Main-hand weapon item id, recovered from the kill feed. Absent when
    /// the player was never a killer or a victim in this battle.
    pub main_hand_item_id: Option<String>,
    /// Role derived from the main-hand weapon, or [`ROLE_UNOBSERVED`] when
    /// the kill feed never showed this player.
    pub role: Option<String>,
    /// Which tier resolved `role`: `"curated"`, `"heuristic"`, or
    /// `"unobserved"`.
    pub role_confidence: Option<&'static str>,
}

/// One equipment item stack recovered from a kill event's victim equipment.
#[derive(Debug, Clone, PartialEq)]
pub struct KillItemRow {
    /// Equipment slot name, e.g. `"MainHand"`, `"Head"`, as it appeared as a
    /// key of the upstream `Equipment` object.
    pub slot: String,
    /// Albion item type id, e.g. `"T8_2H_HOLYSTAFF"`.
    pub item_type_id: String,
    /// Stack quantity. Defaults to `1` when the upstream payload omitted
    /// `Count`/`count`.
    pub quantity: i32,
}

/// One kill event, ready for a `battle_kills`-shaped table.
#[derive(Debug, Clone, PartialEq)]
pub struct KillRow {
    /// `AlbionBB` kill event id.
    pub source_event_id: i64,
    /// Kill time, parsed from [`BattleKillEvent::time`].
    pub occurred_at: DateTime<FixedOffset>,
    /// The killer's identity key. See the [module docs](self).
    pub killer_player_key: String,
    /// Killer name.
    pub killer_name: String,
    /// Killer guild id, when known.
    pub killer_guild_id: Option<String>,
    /// Killer guild name, when known.
    pub killer_guild_name: Option<String>,
    /// The victim's identity key. See the [module docs](self).
    pub victim_player_key: String,
    /// Victim name.
    pub victim_name: String,
    /// Victim guild id, when known.
    pub victim_guild_id: Option<String>,
    /// Victim guild name, when known.
    pub victim_guild_name: Option<String>,
    /// Killer average item power.
    pub killer_item_power: f64,
    /// Victim average item power.
    pub victim_item_power: f64,
    /// Total fame awarded for this kill.
    pub total_kill_fame: i64,
    /// Victim equipment stacks recovered from the kill feed.
    pub items: Vec<KillItemRow>,
}

/// The full set of rows normalized from one battle.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizedEvidence {
    /// One row per guild in the battle.
    pub guilds: Vec<GuildStatRow>,
    /// One row per player in the battle.
    pub players: Vec<PlayerStatRow>,
    /// One row per successfully time-parsed kill event.
    pub kills: Vec<KillRow>,
}

/// Computes the stable player identity key described in the [module docs](self).
///
/// Trims `id` first; a non-empty id always wins over the name fallback,
/// because an id is unambiguous while two different players can share a
/// display name.
fn player_identity(id: &str, name: &str) -> (String, &'static str) {
    let trimmed_id = id.trim();
    if trimmed_id.is_empty() {
        (
            format!("name:{}", name.trim().to_ascii_lowercase()),
            "name_only",
        )
    } else {
        (format!("id:{trimmed_id}"), "player_id")
    }
}

/// Converts a stat count that is `i64` upstream into the `i32` a row column
/// wants, saturating rather than panicking on the (never-expected-in-practice)
/// overflow case.
fn saturating_i32(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

/// Walks `raw.Victim.Equipment` (or the lowercase-keyed equivalent) into one
/// [`KillItemRow`] per occupied slot.
///
/// This is a fresh, minimal walker rather than a reuse of
/// `battles::service`'s private equipment collectors: those are private to
/// that file and, more importantly, they flatten across slots and so cannot
/// tell us which slot an item stack came from, which `KillItemRow::slot`
/// needs. Known simplification: each slot key is expected to hold at most one
/// plain `{"Type"/"type": ..., "Count"/"count": ...}` object, mirroring
/// `intel::scout::main_hand_of`'s pattern; a slot that is `null`, missing a
/// string `Type`/`type`, or shaped as an array (multi-item slots) is skipped
/// rather than guessed at.
fn victim_equipment_items(raw: &Value) -> Vec<KillItemRow> {
    let mut items = Vec::new();
    let Some(victim) = raw.get("Victim").or_else(|| raw.get("victim")) else {
        return items;
    };
    let Some(equipment) = victim.get("Equipment").or_else(|| victim.get("equipment")) else {
        return items;
    };
    let Some(slots) = equipment.as_object() else {
        return items;
    };

    for (slot, value) in slots {
        if value.is_null() {
            continue;
        }
        let Some(item) = value.as_object() else {
            continue;
        };
        let Some(item_type) = item
            .get("Type")
            .or_else(|| item.get("type"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let trimmed = item_type.trim();
        if trimmed.is_empty() {
            continue;
        }
        let quantity = item
            .get("Count")
            .or_else(|| item.get("count"))
            .and_then(Value::as_i64)
            .and_then(|count| i32::try_from(count).ok())
            .unwrap_or(1);
        items.push(KillItemRow {
            slot: slot.clone(),
            item_type_id: trimmed.to_string(),
            quantity,
        });
    }

    items
}

/// Normalizes one battle's parsed `AlbionBB` data into flat, SQL-ready rows.
///
/// Pure and synchronous: no database access happens here, so callers can unit
/// test the mapping without a DB and reuse it from whatever ingestion path
/// eventually persists the rows.
#[must_use]
pub fn normalize(
    guilds: &[BattleGuildSummary],
    players: &[BattlePlayer],
    kills: &[BattleKillEvent],
    side: &FriendlySide,
    classifier: &RoleClassifier,
) -> NormalizedEvidence {
    let guild_rows = guilds
        .iter()
        .map(|guild| GuildStatRow {
            guild_id: guild.id.clone(),
            guild_name: guild.name.clone(),
            alliance_id: guild.alliance_id.clone(),
            alliance_name: guild.alliance_name.clone(),
            is_friendly: side.contains(&guild.id, &guild.name),
            players: saturating_i32(guild.players),
            kills: saturating_i32(guild.kills),
            deaths: saturating_i32(guild.deaths),
            kill_fame: guild.kill_fame,
            avg_item_power: guild.average_item_power,
            winner: guild.winner,
        })
        .collect();

    // Built once and shared across every player, mirroring
    // `intel::scout::scout_from_snapshot`: both sides of every kill are
    // harvested, so a player who only killed still gets a weapon.
    let weapons = weapons_by_player(kills);

    let player_rows = players
        .iter()
        .map(|player| {
            let (player_key, identity_source) = player_identity(&player.id, &player.name);
            let player_id = {
                let trimmed = player.id.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            };

            let weapon = weapons.get(&player.name).cloned();
            let (role, role_confidence, main_hand_item_id) = match weapon {
                Some(item) => {
                    let (role, confidence) = classifier.classify(&item);
                    let confidence_str = if confidence == RoleConfidence::Heuristic {
                        "heuristic"
                    } else {
                        "curated"
                    };
                    (
                        Some(role.as_str().to_string()),
                        Some(confidence_str),
                        Some(item),
                    )
                }
                None => (Some(ROLE_UNOBSERVED.to_string()), Some("unobserved"), None),
            };

            PlayerStatRow {
                player_key,
                player_id,
                player_name: player.name.clone(),
                identity_source,
                guild_id: player.guild_id.clone(),
                guild_name: player.guild_name.clone(),
                alliance_name: player.alliance_name.clone(),
                is_friendly: side.contains(&player.guild_id, &player.guild_name),
                kills: saturating_i32(player.kills),
                deaths: saturating_i32(player.deaths),
                kill_fame: player.kill_fame,
                death_fame: player.death_fame,
                item_power: player.item_power,
                main_hand_item_id,
                role,
                role_confidence,
            }
        })
        .collect();

    let kill_rows = kills
        .iter()
        .filter_map(|kill| {
            // A kill whose `time` does not parse as RFC 3339 is skipped rather
            // than persisted with a fabricated timestamp or panicking: the
            // upstream feed is not something we control, and a single bad
            // timestamp must not take the rest of the battle's evidence down
            // with it.
            let occurred_at = DateTime::parse_from_rfc3339(&kill.time).ok()?;

            let (killer_player_key, _) = player_identity(&kill.killer.id, &kill.killer.name);
            let (victim_player_key, _) = player_identity(&kill.victim.id, &kill.victim.name);

            Some(KillRow {
                source_event_id: kill.event_id,
                occurred_at,
                killer_player_key,
                killer_name: kill.killer.name.clone(),
                killer_guild_id: kill.killer.guild_id.clone(),
                killer_guild_name: kill.killer.guild_name.clone(),
                victim_player_key,
                victim_name: kill.victim.name.clone(),
                victim_guild_id: kill.victim.guild_id.clone(),
                victim_guild_name: kill.victim.guild_name.clone(),
                killer_item_power: kill.killer_item_power,
                victim_item_power: kill.victim_item_power,
                total_kill_fame: kill.total_kill_fame,
                items: victim_equipment_items(&kill.raw),
            })
        })
        .collect();

    NormalizedEvidence {
        guilds: guild_rows,
        players: player_rows,
        kills: kill_rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    use crate::modules::comps::status::BuildRole;

    fn side() -> FriendlySide {
        FriendlySide::new(
            "our-guild",
            &["ally-id".to_string()],
            &["Friendly".to_string()],
        )
    }

    fn classifier() -> RoleClassifier {
        RoleClassifier::from_curated(HashMap::from([(
            "2H_HOLYSTAFF".to_string(),
            BuildRole::Healer,
        )]))
    }

    fn guild(id: &str, name: &str, winner: bool) -> BattleGuildSummary {
        BattleGuildSummary {
            id: id.to_string(),
            name: name.to_string(),
            alliance_name: None,
            alliance_id: None,
            players: 2,
            kills: 3,
            deaths: 1,
            kill_fame: 10_000,
            winner,
            average_item_power: 1300.0,
        }
    }

    fn player(id: &str, name: &str, guild_id: &str, guild_name: &str) -> BattlePlayer {
        BattlePlayer {
            id: id.to_string(),
            name: name.to_string(),
            guild_id: guild_id.to_string(),
            guild_name: guild_name.to_string(),
            alliance_name: None,
            alliance_id: None,
            kills: 1,
            deaths: 0,
            kill_fame: 5_000,
            death_fame: 0,
            item_power: 1300.0,
        }
    }

    fn kill_event(
        event_id: i64,
        time: &str,
        killer_name: &str,
        killer_weapon: &str,
        victim_name: &str,
        victim_equipment: &Value,
    ) -> BattleKillEvent {
        serde_json::from_value(json!({
            "event_id": event_id,
            "time": time,
            "killer": {
                "id": format!("k-{killer_name}"),
                "name": killer_name,
                "guild_id": "our-guild",
                "guild_name": "Weaklings",
            },
            "victim": {
                "id": "",
                "name": victim_name,
                "guild_id": "foe-1",
                "guild_name": "Foe One",
            },
            "killer_item_power": 1400.0,
            "victim_item_power": 1300.0,
            "total_kill_fame": 100,
            "raw": {
                "Killer": { "Equipment": { "MainHand": { "Type": killer_weapon } } },
                "Victim": { "Equipment": victim_equipment },
            }
        }))
        .expect("fixture must deserialize")
    }

    #[test]
    fn friendly_and_enemy_guilds_pass_through_stats_and_flag_is_friendly() {
        let guilds = [
            guild("our-guild", "Weaklings", true),
            guild("foe-1", "Foe One", false),
        ];
        let evidence = normalize(&guilds, &[], &[], &side(), &classifier());

        let ours = evidence
            .guilds
            .iter()
            .find(|row| row.guild_id == "our-guild")
            .unwrap();
        assert!(ours.is_friendly);
        assert!(ours.winner);
        assert_eq!(ours.players, 2);
        assert_eq!(ours.kills, 3);
        assert_eq!(ours.deaths, 1);
        assert_eq!(ours.kill_fame, 10_000);
        assert!((ours.avg_item_power - 1300.0).abs() < f64::EPSILON);

        let theirs = evidence
            .guilds
            .iter()
            .find(|row| row.guild_id == "foe-1")
            .unwrap();
        assert!(!theirs.is_friendly);
        assert!(!theirs.winner);
    }

    /// Mirrors `intel::scout::tests::weapon_coverage_reflects_kill_feed_only`:
    /// a player seen in the kill feed gets a real role, one that was never
    /// seen gets `ROLE_UNOBSERVED` and no weapon.
    #[test]
    fn role_resolution_mirrors_kill_feed_coverage() {
        let players = [
            player("p1", "Seen", "our-guild", "Weaklings"),
            player("p2", "Unseen", "our-guild", "Weaklings"),
        ];
        let kills = [kill_event(
            1,
            "2026-08-01T00:00:00Z",
            "Seen",
            "T8_2H_HOLYSTAFF",
            "Victim",
            &json!({ "MainHand": { "Type": "T8_2H_BOW" } }),
        )];

        let evidence = normalize(&[], &players, &kills, &side(), &classifier());

        let seen = evidence
            .players
            .iter()
            .find(|row| row.player_name == "Seen")
            .unwrap();
        assert_eq!(seen.main_hand_item_id.as_deref(), Some("T8_2H_HOLYSTAFF"));
        assert_eq!(seen.role.as_deref(), Some("healer"));
        assert_eq!(seen.role_confidence, Some("curated"));

        let unseen = evidence
            .players
            .iter()
            .find(|row| row.player_name == "Unseen")
            .unwrap();
        assert_eq!(unseen.main_hand_item_id, None);
        assert_eq!(unseen.role.as_deref(), Some(ROLE_UNOBSERVED));
        assert_eq!(unseen.role_confidence, Some("unobserved"));
    }

    #[test]
    fn player_identity_prefers_id_and_falls_back_to_lowercased_name() {
        let players = [
            player("abc123", "HasId", "our-guild", "Weaklings"),
            player("", "NoId", "our-guild", "Weaklings"),
        ];
        let evidence = normalize(&[], &players, &[], &side(), &classifier());

        let with_id = evidence
            .players
            .iter()
            .find(|row| row.player_name == "HasId")
            .unwrap();
        assert_eq!(with_id.player_key, "id:abc123");
        assert_eq!(with_id.identity_source, "player_id");
        assert_eq!(with_id.player_id.as_deref(), Some("abc123"));

        let without_id = evidence
            .players
            .iter()
            .find(|row| row.player_name == "NoId")
            .unwrap();
        assert_eq!(without_id.player_key, "name:noid");
        assert_eq!(without_id.identity_source, "name_only");
        assert_eq!(without_id.player_id, None);
    }

    #[test]
    fn victim_equipment_is_extracted_with_slots_and_quantities() {
        let kills = [kill_event(
            1,
            "2026-08-01T00:00:00Z",
            "Killer",
            "T8_2H_BOW",
            "Victim",
            &json!({
                "MainHand": { "Type": "T8_2H_HOLYSTAFF", "Count": 1 },
                "Bag": { "Type": "T4_BAG", "Count": 5 },
                "Head": { "Type": "T8_HEAD_PLATE_SET1" },
                "Cape": null,
            }),
        )];

        let evidence = normalize(&[], &[], &kills, &side(), &classifier());
        let items = &evidence.kills[0].items;
        assert_eq!(items.len(), 3, "the null Cape slot must be skipped");

        let bag = items.iter().find(|i| i.slot == "Bag").unwrap();
        assert_eq!(bag.item_type_id, "T4_BAG");
        assert_eq!(bag.quantity, 5);

        let head = items.iter().find(|i| i.slot == "Head").unwrap();
        assert_eq!(head.item_type_id, "T8_HEAD_PLATE_SET1");
        assert_eq!(head.quantity, 1, "missing Count must default to 1");
    }

    #[test]
    fn a_kill_with_an_unparseable_time_is_skipped_not_panicked_on() {
        let good = kill_event(
            1,
            "2026-08-01T00:00:00Z",
            "Killer",
            "T8_2H_BOW",
            "Victim",
            &json!({}),
        );
        let bad = kill_event(
            2,
            "not-a-timestamp",
            "Killer",
            "T8_2H_BOW",
            "Victim2",
            &json!({}),
        );

        let evidence = normalize(&[], &[], &[good, bad], &side(), &classifier());
        assert_eq!(evidence.kills.len(), 1);
        assert_eq!(evidence.kills[0].source_event_id, 1);
    }

    /// Honest scope: this proves the pure function itself is idempotent given
    /// identical inputs. True cross-battle dedup by `source_event_id` needs
    /// database state (has this event already been persisted?) and is out of
    /// scope for a DB-free normalizer — that belongs to the later integration
    /// step that owns the actual insert/upsert.
    #[test]
    fn normalize_is_idempotent_for_identical_inputs() {
        let guilds = [
            guild("our-guild", "Weaklings", true),
            guild("foe-1", "Foe One", false),
        ];
        let players = [
            player("p1", "Seen", "our-guild", "Weaklings"),
            player("", "NoId", "foe-1", "Foe One"),
        ];
        let kills = [kill_event(
            1,
            "2026-08-01T00:00:00Z",
            "Seen",
            "T8_2H_HOLYSTAFF",
            "NoId",
            &json!({ "MainHand": { "Type": "T8_2H_BOW", "Count": 1 } }),
        )];

        let first = normalize(&guilds, &players, &kills, &side(), &classifier());
        let second = normalize(&guilds, &players, &kills, &side(), &classifier());

        assert_eq!(first.guilds, second.guilds);
        assert_eq!(first.players, second.players);
        assert_eq!(first.kills, second.kills);
    }

    /// The invariant a later reconciliation report checks against real data:
    /// summing per-guild stats over the produced rows must equal what went
    /// into the fixture's `BattleGuildSummary` inputs.
    #[test]
    fn guild_stat_rows_reconcile_to_the_input_totals() {
        let guilds = [
            guild("our-guild", "Weaklings", true),
            guild("foe-1", "Foe One", false),
            guild("foe-2", "Foe Two", false),
        ];
        let expected_kills: i64 = guilds.iter().map(|g| g.kills).sum();
        let expected_deaths: i64 = guilds.iter().map(|g| g.deaths).sum();
        let expected_fame: i64 = guilds.iter().map(|g| g.kill_fame).sum();

        let evidence = normalize(&guilds, &[], &[], &side(), &classifier());

        let summed_kills: i64 = evidence.guilds.iter().map(|row| i64::from(row.kills)).sum();
        let summed_deaths: i64 = evidence
            .guilds
            .iter()
            .map(|row| i64::from(row.deaths))
            .sum();
        let summed_fame: i64 = evidence.guilds.iter().map(|row| row.kill_fame).sum();

        assert_eq!(summed_kills, expected_kills);
        assert_eq!(summed_deaths, expected_deaths);
        assert_eq!(summed_fame, expected_fame);
    }
}
