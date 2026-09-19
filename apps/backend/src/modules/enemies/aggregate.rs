//! Pure, DB-free aggregation of one battle's evidence into enemy identity facts.
//!
//! This module reads the already-persisted evidence for a single battle
//! (guild stat rows, player stat rows, kill rows — see
//! `battles::evidence_entities` for the tables these mirror) and computes
//! exactly what an enemy identity layer needs upserted: which enemy guilds
//! and enemy players were observed, and how many kills were traded against
//! each enemy player specifically by our side, within this one battle.
//!
//! Deliberately decoupled from `battles::evidence_entities`: the input
//! structs here mirror those tables' columns exactly, but are plain data,
//! not `SeaORM` entities, so this module has no database dependency and can
//! be unit tested without one. A later integration step maps real query
//! results onto [`GuildStatSource`], [`PlayerStatSource`] and [`KillSource`].

use crate::modules::battles::outcome::FriendlySide;

/// Mirrors one row of `battle_guild_stats`.
#[derive(Debug, Clone, PartialEq)]
pub struct GuildStatSource {
    pub guild_id: String,
    pub guild_name: String,
    pub alliance_id: Option<String>,
    pub alliance_name: Option<String>,
    pub is_friendly: bool,
}

/// Mirrors one row of `battle_player_stats`.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerStatSource {
    /// Already computed upstream — reused verbatim, never recomputed here.
    pub player_key: String,
    pub player_id: Option<String>,
    pub player_name: String,
    /// `"player_id"` or `"name_only"`, reused verbatim.
    pub identity_source: &'static str,
    pub guild_id: String,
    pub guild_name: String,
    pub is_friendly: bool,
    pub role: Option<String>,
    pub main_hand_item_id: Option<String>,
    pub item_power: f64,
}

/// Mirrors one row of `battle_kills`.
#[derive(Debug, Clone, PartialEq)]
pub struct KillSource {
    pub killer_player_key: String,
    pub killer_guild_id: Option<String>,
    pub killer_guild_name: Option<String>,
    pub victim_player_key: String,
    pub victim_guild_id: Option<String>,
    pub victim_guild_name: Option<String>,
}

/// One enemy guild observed in this battle, ready to be upserted.
#[derive(Debug, Clone, PartialEq)]
pub struct EnemyGuildFact {
    pub guild_key: String,
    pub albion_guild_id: Option<String>,
    pub name: String,
    pub alliance_id: Option<String>,
    pub alliance_name: Option<String>,
}

/// One enemy player observed in this battle, ready to be upserted, plus their
/// kill trade against us within this single battle.
#[derive(Debug, Clone, PartialEq)]
pub struct EnemyPlayerFact {
    pub player_key: String,
    pub player_id: Option<String>,
    pub name: String,
    pub identity_source: &'static str,
    /// Links back to the [`EnemyGuildFact`] this player belongs to.
    pub guild_key: String,
    pub role: Option<String>,
    pub main_hand_item_id: Option<String>,
    pub item_power: f64,
    /// Kills we landed on this player, in this battle.
    pub our_kills_on_them: i32,
    /// Kills this player landed on us, in this battle.
    pub their_kills_on_us: i32,
}

/// The full set of enemy facts observed in one battle.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BattleEnemyFacts {
    pub guilds: Vec<EnemyGuildFact>,
    pub players: Vec<EnemyPlayerFact>,
}

/// Computes the stable guild identity key: trimmed id wins, else lowercased
/// trimmed name. Identical shape to the player-key fallback in
/// `battles::evidence::player_identity`, so a guild's key is consistent
/// wherever it is computed — from a guild stat row or from a kill
/// participant's raw guild fields.
fn guild_key(guild_id: &str, guild_name: &str) -> String {
    let trimmed_id = guild_id.trim();
    if trimmed_id.is_empty() {
        format!("name:{}", guild_name.trim().to_ascii_lowercase())
    } else {
        format!("id:{trimmed_id}")
    }
}

/// Aggregates one battle's evidence into enemy identity facts.
///
/// Pure and synchronous: no database access happens here.
///
/// # Kill trade scope
///
/// Only kills where exactly one side is friendly and the other is a
/// specific, resolved enemy player contribute to `our_kills_on_them` /
/// `their_kills_on_us`. A kill where both sides are friendly (friendly fire,
/// if that is even representable) or both sides are enemy (a fight between
/// two other guilds inside the same multi-guild battle) contributes to
/// neither counter — this module only measures trade between "us" and each
/// specific enemy, not enemy-vs-enemy chaos in a large battle.
///
/// A kill against a player with no corresponding [`PlayerStatSource`] row
/// (e.g. a victim only ever seen in the kill feed) is not counted: only
/// `player_stats` rows become [`EnemyPlayerFact`]s, since only those carry a
/// resolved role/build/guild, so no phantom fact is fabricated from kill
/// data alone.
#[must_use]
pub fn aggregate_battle(
    guild_stats: &[GuildStatSource],
    player_stats: &[PlayerStatSource],
    kills: &[KillSource],
    side: &FriendlySide,
) -> BattleEnemyFacts {
    // Defensive dedup by `guild_key`: normally one row per guild per battle,
    // but if the input ever repeats a key, last one wins rather than
    // producing duplicate facts. An index map preserves first-seen order
    // while still letting a later row overwrite an earlier one.
    let mut guild_order: Vec<String> = Vec::new();
    let mut guild_facts: std::collections::HashMap<String, EnemyGuildFact> =
        std::collections::HashMap::new();
    for guild in guild_stats {
        if guild.is_friendly {
            continue;
        }
        let key = guild_key(&guild.guild_id, &guild.guild_name);
        let trimmed_id = guild.guild_id.trim();
        let fact = EnemyGuildFact {
            guild_key: key.clone(),
            albion_guild_id: (!trimmed_id.is_empty()).then(|| trimmed_id.to_string()),
            name: guild.guild_name.clone(),
            alliance_id: guild.alliance_id.clone(),
            alliance_name: guild.alliance_name.clone(),
        };
        if !guild_facts.contains_key(&key) {
            guild_order.push(key.clone());
        }
        guild_facts.insert(key, fact);
    }
    let guilds: Vec<EnemyGuildFact> = guild_order
        .into_iter()
        .map(|key| guild_facts.remove(&key).expect("key was just inserted"))
        .collect();

    let mut players: Vec<EnemyPlayerFact> = player_stats
        .iter()
        .filter(|player| !player.is_friendly)
        .map(|player| EnemyPlayerFact {
            player_key: player.player_key.clone(),
            player_id: player.player_id.clone(),
            name: player.player_name.clone(),
            identity_source: player.identity_source,
            guild_key: guild_key(&player.guild_id, &player.guild_name),
            role: player.role.clone(),
            main_hand_item_id: player.main_hand_item_id.clone(),
            item_power: player.item_power,
            our_kills_on_them: 0,
            their_kills_on_us: 0,
        })
        .collect();

    for kill in kills {
        let killer_friendly = side.contains(
            kill.killer_guild_id.as_deref().unwrap_or_default(),
            kill.killer_guild_name.as_deref().unwrap_or_default(),
        );
        let victim_friendly = side.contains(
            kill.victim_guild_id.as_deref().unwrap_or_default(),
            kill.victim_guild_name.as_deref().unwrap_or_default(),
        );

        if killer_friendly
            && !victim_friendly
            && let Some(victim) = players
                .iter_mut()
                .find(|player| player.player_key == kill.victim_player_key)
        {
            victim.our_kills_on_them += 1;
        } else if victim_friendly
            && !killer_friendly
            && let Some(killer) = players
                .iter_mut()
                .find(|player| player.player_key == kill.killer_player_key)
        {
            killer.their_kills_on_us += 1;
        }
        // Both friendly or both enemy: contributes to neither counter, by
        // design (see the doc comment above).
    }

    BattleEnemyFacts { guilds, players }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side() -> FriendlySide {
        FriendlySide::new("our-guild", &[], &[])
    }

    fn guild_stat(id: &str, name: &str, is_friendly: bool) -> GuildStatSource {
        GuildStatSource {
            guild_id: id.to_string(),
            guild_name: name.to_string(),
            alliance_id: None,
            alliance_name: None,
            is_friendly,
        }
    }

    fn player_stat(
        player_key: &str,
        name: &str,
        guild_id: &str,
        guild_name: &str,
        is_friendly: bool,
    ) -> PlayerStatSource {
        PlayerStatSource {
            player_key: player_key.to_string(),
            player_id: Some("pid".to_string()),
            player_name: name.to_string(),
            identity_source: "player_id",
            guild_id: guild_id.to_string(),
            guild_name: guild_name.to_string(),
            is_friendly,
            role: Some("healer".to_string()),
            main_hand_item_id: Some("T8_2H_HOLYSTAFF".to_string()),
            item_power: 1350.0,
        }
    }

    fn kill(
        killer_key: &str,
        killer_guild_id: &str,
        killer_guild_name: &str,
        victim_key: &str,
        victim_guild_id: &str,
        victim_guild_name: &str,
    ) -> KillSource {
        KillSource {
            killer_player_key: killer_key.to_string(),
            killer_guild_id: Some(killer_guild_id.to_string()),
            killer_guild_name: Some(killer_guild_name.to_string()),
            victim_player_key: victim_key.to_string(),
            victim_guild_id: Some(victim_guild_id.to_string()),
            victim_guild_name: Some(victim_guild_name.to_string()),
        }
    }

    #[test]
    fn guild_key_prefers_trimmed_id_and_falls_back_to_lowercased_name() {
        assert_eq!(guild_key(" foe-1 ", "Foe One"), "id:foe-1");
        assert_eq!(guild_key("", "  Foe One  "), "name:foe one");
        assert_eq!(guild_key("   ", "Foe One"), "name:foe one");
    }

    #[test]
    fn friendly_guild_is_excluded_enemy_guild_produces_a_fact_with_id() {
        let guild_stats = [
            guild_stat("our-guild", "Weaklings", true),
            guild_stat("foe-1", "Foe One", false),
        ];
        let facts = aggregate_battle(&guild_stats, &[], &[], &side());

        assert_eq!(facts.guilds.len(), 1);
        let foe = &facts.guilds[0];
        assert_eq!(foe.guild_key, "id:foe-1");
        assert_eq!(foe.albion_guild_id.as_deref(), Some("foe-1"));
        assert_eq!(foe.name, "Foe One");
    }

    #[test]
    fn enemy_guild_without_id_falls_back_to_name_key_and_no_albion_id() {
        let guild_stats = [guild_stat("", "Foe Two", false)];
        let facts = aggregate_battle(&guild_stats, &[], &[], &side());

        assert_eq!(facts.guilds.len(), 1);
        let foe = &facts.guilds[0];
        assert_eq!(foe.guild_key, "name:foe two");
        assert_eq!(foe.albion_guild_id, None);
    }

    #[test]
    fn friendly_player_is_excluded_enemy_player_passes_through_and_links_to_guild() {
        let player_stats = [
            player_stat("id:friend", "Friend", "our-guild", "Weaklings", true),
            player_stat("id:foe", "FoeGuy", "foe-1", "Foe One", false),
        ];
        let facts = aggregate_battle(&[], &player_stats, &[], &side());

        assert_eq!(facts.players.len(), 1);
        let foe = &facts.players[0];
        assert_eq!(foe.player_key, "id:foe");
        assert_eq!(foe.name, "FoeGuy");
        assert_eq!(foe.identity_source, "player_id");
        assert_eq!(foe.role.as_deref(), Some("healer"));
        assert_eq!(foe.main_hand_item_id.as_deref(), Some("T8_2H_HOLYSTAFF"));
        assert!((foe.item_power - 1350.0).abs() < f64::EPSILON);
        assert_eq!(foe.guild_key, "id:foe-1");
        assert_eq!(foe.our_kills_on_them, 0);
        assert_eq!(foe.their_kills_on_us, 0);
    }

    #[test]
    fn friendly_killer_vs_enemy_victim_increments_our_kills_on_them() {
        let player_stats = [player_stat("id:foe", "FoeGuy", "foe-1", "Foe One", false)];
        let kills = [kill(
            "id:friend",
            "our-guild",
            "Weaklings",
            "id:foe",
            "foe-1",
            "Foe One",
        )];
        let facts = aggregate_battle(&[], &player_stats, &kills, &side());

        let foe = facts
            .players
            .iter()
            .find(|p| p.player_key == "id:foe")
            .unwrap();
        assert_eq!(foe.our_kills_on_them, 1);
        assert_eq!(foe.their_kills_on_us, 0);
    }

    #[test]
    fn enemy_killer_vs_friendly_victim_increments_their_kills_on_us() {
        let player_stats = [player_stat("id:foe", "FoeGuy", "foe-1", "Foe One", false)];
        let kills = [kill(
            "id:foe",
            "foe-1",
            "Foe One",
            "id:friend",
            "our-guild",
            "Weaklings",
        )];
        let facts = aggregate_battle(&[], &player_stats, &kills, &side());

        let foe = facts
            .players
            .iter()
            .find(|p| p.player_key == "id:foe")
            .unwrap();
        assert_eq!(foe.our_kills_on_them, 0);
        assert_eq!(foe.their_kills_on_us, 1);
    }

    #[test]
    fn a_kill_between_two_enemy_guilds_increments_neither_counter() {
        let player_stats = [
            player_stat("id:foe-a", "FoeA", "foe-1", "Foe One", false),
            player_stat("id:foe-b", "FoeB", "foe-2", "Foe Two", false),
        ];
        let kills = [kill(
            "id:foe-a", "foe-1", "Foe One", "id:foe-b", "foe-2", "Foe Two",
        )];
        let facts = aggregate_battle(&[], &player_stats, &kills, &side());

        for foe in &facts.players {
            assert_eq!(foe.our_kills_on_them, 0);
            assert_eq!(foe.their_kills_on_us, 0);
        }
    }

    #[test]
    fn a_kill_against_a_player_with_no_stat_row_is_silently_dropped() {
        // The victim never appears in player_stats (e.g. only seen in the
        // kill feed), so no EnemyPlayerFact exists to attribute the kill to.
        let player_stats: [PlayerStatSource; 0] = [];
        let kills = [kill(
            "id:friend",
            "our-guild",
            "Weaklings",
            "id:ghost",
            "foe-1",
            "Foe One",
        )];
        let facts = aggregate_battle(&[], &player_stats, &kills, &side());

        assert!(facts.players.is_empty(), "no phantom fact must appear");
    }

    #[test]
    fn multiple_kills_by_the_same_enemy_against_different_friendlies_accumulate() {
        let player_stats = [player_stat("id:foe", "FoeGuy", "foe-1", "Foe One", false)];
        let kills = [
            kill(
                "id:foe",
                "foe-1",
                "Foe One",
                "id:friend-a",
                "our-guild",
                "Weaklings",
            ),
            kill(
                "id:foe",
                "foe-1",
                "Foe One",
                "id:friend-b",
                "our-guild",
                "Weaklings",
            ),
        ];
        let facts = aggregate_battle(&[], &player_stats, &kills, &side());

        let foe = facts
            .players
            .iter()
            .find(|p| p.player_key == "id:foe")
            .unwrap();
        assert_eq!(foe.their_kills_on_us, 2);
        assert_eq!(foe.our_kills_on_them, 0);
    }

    #[test]
    fn duplicate_guild_stat_rows_with_the_same_key_dedup_to_one_fact() {
        // Defensive case: not expected in practice (one row per guild per
        // battle), but the aggregator must not emit duplicate facts if it
        // ever happens. Last one wins.
        let guild_stats = [
            GuildStatSource {
                guild_id: "foe-1".to_string(),
                guild_name: "Foe One Old Name".to_string(),
                alliance_id: None,
                alliance_name: None,
                is_friendly: false,
            },
            GuildStatSource {
                guild_id: "foe-1".to_string(),
                guild_name: "Foe One New Name".to_string(),
                alliance_id: Some("alliance-1".to_string()),
                alliance_name: Some("Alliance One".to_string()),
                is_friendly: false,
            },
        ];
        let facts = aggregate_battle(&guild_stats, &[], &[], &side());

        assert_eq!(facts.guilds.len(), 1);
        assert_eq!(facts.guilds[0].name, "Foe One New Name");
        assert_eq!(facts.guilds[0].alliance_id.as_deref(), Some("alliance-1"));
    }
}
