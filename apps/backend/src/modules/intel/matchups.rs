//! Win/loss tallies of our compositions against scouted enemy compositions.
//!
//! The join runs scout → source battles → `event_battles` → event → comp. Only
//! battles that were linked to an event carry a comp, so a battle picked up by
//! the background sync but never attached to an event contributes a scout and
//! no matchup row. That is reported rather than hidden: officers who cannot see
//! why a matrix is sparse will assume the feature is broken.
//!
//! Outcomes come from each battle's canonical Fight (`fights.outcome`,
//! persisted by `fight_analytics`) and are never recomputed here, so this
//! module and the events module can never disagree. A Fight whose outcome is
//! still `"unknown"` (never recomputed) is treated as absent data, exactly
//! like a battle with no event association at all — excluded from both wins
//! and losses, not counted as a loss.
//!
//! Raw `scouted_comp_battles.battle_id` values are `AlbionBB` battle
//! segments, and a single real engagement can be split by `AlbionBB` into
//! several of them — counting each segment as its own battle used to
//! double-count that one engagement whenever more than one of its segments
//! got linked to the same scout. This is now fixed: every battle id is
//! resolved to its canonical Fight via the table-wide-unique
//! `fight_battles.battle_id -> fight_id` mapping, and both `MatchupRow`
//! (`battles`/`wins`/`losses`) and `MatchupCoverage`
//! (`total_battles`/`battles_with_comp`) count/attribute distinct Fights, not
//! raw battle segments. When two segments of the same fight resolve to an
//! outcome, the first one encountered decides the fight's outcome for that
//! cell — the same "first association wins" rule already applied below to a
//! battle linked to several events.

use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::comps::entities::comp;
use crate::modules::events::entities::{event, event_battle, fight, fight_battle};
use crate::modules::events::service::ratio_percent;
use crate::modules::intel::entities::scouted_comp_battle;

/// A battle's canonical Fight, or the battle itself when no `fight_battles`
/// row maps it (should not normally happen — every hydrated battle gets a
/// seeded Fight — but this keeps an unmapped battle from being silently
/// dropped or wrongly merged with an unrelated one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum FightKey {
    Fight(i64),
    UnmappedBattle(i64),
}

fn fight_key_of(battle_id: i64, fight_id_by_battle: &HashMap<i64, i64>) -> FightKey {
    match fight_id_by_battle.get(&battle_id) {
        Some(fight_id) => FightKey::Fight(*fight_id),
        None => FightKey::UnmappedBattle(battle_id),
    }
}

/// One cell of the matchup matrix: how one of our comps fares against one scout.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MatchupRow {
    /// Our composition's id.
    pub our_comp_id: i64,
    /// Our composition's name.
    pub our_comp_name: String,
    /// The scouted enemy composition's id.
    pub scouted_comp_id: i64,
    /// Distinct Fights counted in this cell — not raw `AlbionBB` battle
    /// segments, see the module doc comment.
    pub battles: i64,
    /// Fights won.
    pub wins: i64,
    /// Fights lost.
    pub losses: i64,
    /// Win percentage, 0-100.
    pub win_rate: f64,
}

/// Coverage information so callers can explain a sparse matrix.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct MatchupCoverage {
    /// Distinct canonical Fights (resolved via `fight_battles`) linked to the
    /// scouts under consideration — not raw battle segments.
    pub total_battles: i64,
    /// How many of those fights resolved to one of our comps via an event.
    pub battles_with_comp: i64,
}

/// The matrix plus the coverage caveat that explains its gaps.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct MatchupReport {
    /// One row per (our comp, scout) pair that has at least one battle.
    pub rows: Vec<MatchupRow>,
    /// How much of the underlying data could be attributed to a comp.
    pub coverage: MatchupCoverage,
}

/// Tallies wins and losses per (our comp, scouted comp) pair.
///
/// Pass an empty `scout_ids` to cover every scout. The battle-id join is done
/// in two steps in Rust rather than in SQL: `scouted_comp_battles.battle_id` is
/// an integer while `event_battles.albionbb_battle_id` is a string, and a SQL
/// cast would be Postgres-only and break the `SQLite` test backend.
///
/// A battle with no matching `event_battles` row, or whose canonical Fight's
/// outcome is still `"unknown"`, is treated as *absent data*, never as a
/// loss — the background workers write snapshots and outcomes on separate
/// ticks, so a scout routinely exists before its outcome does.
///
/// Every battle id is first resolved to its canonical Fight via
/// `fight_battles`, and counting/attribution below happens per distinct Fight,
/// not per raw battle segment — see the module doc comment.
#[allow(clippy::too_many_lines)]
pub async fn matchups(
    db: &DatabaseConnection,
    scout_ids: &[i64],
) -> Result<MatchupReport, AppError> {
    let mut links_query = scouted_comp_battle::Entity::find();
    if !scout_ids.is_empty() {
        links_query = links_query
            .filter(scouted_comp_battle::Column::ScoutedCompId.is_in(scout_ids.to_vec()));
    }
    let links = links_query.all(db).await?;
    if links.is_empty() {
        return Ok(MatchupReport::default());
    }

    let battle_ids: Vec<i64> = {
        let mut ids: Vec<i64> = links.iter().map(|link| link.battle_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };

    // Resolve each battle to its canonical Fight so a real engagement split
    // by AlbionBB into several technical battle segments is counted once,
    // not once per segment. `fight_battles.battle_id` is unique table-wide,
    // so this lookup is always safe.
    let fight_id_by_battle: HashMap<i64, i64> = fight_battle::Entity::find()
        .filter(fight_battle::Column::BattleId.is_in(battle_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.battle_id, row.fight_id))
        .collect();

    // Two-step join: integer ids stringified to match the event_battles column.
    let battle_id_strings: Vec<String> = battle_ids.iter().map(i64::to_string).collect();
    let event_battles = event_battle::Entity::find()
        .filter(event_battle::Column::AlbionbbBattleId.is_in(battle_id_strings))
        .all(db)
        .await?;

    // battle id -> event id. A battle linked to several events keeps the
    // first association, which is the same rule the events module applies.
    // Win/loss no longer comes from this table — see `outcome_by_fight`
    // below — only the event association does.
    let mut event_by_battle: HashMap<i64, i64> = HashMap::new();
    for row in &event_battles {
        let Ok(battle_id) = row.albionbb_battle_id.parse::<i64>() else {
            continue;
        };
        event_by_battle.entry(battle_id).or_insert(row.event_id);
    }

    // Outcomes come from each battle's canonical Fight (resolved above via
    // `fight_battles`), not from the deprecated `event_battles.is_win`
    // column.
    let fight_ids: Vec<i64> = {
        let mut ids: Vec<i64> = fight_id_by_battle.values().copied().collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let outcome_by_fight: HashMap<i64, String> = if fight_ids.is_empty() {
        HashMap::new()
    } else {
        fight::Entity::find()
            .filter(fight::Column::Id.is_in(fight_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.outcome))
            .collect()
    };

    let event_ids: Vec<i64> = {
        let mut ids: Vec<i64> = event_by_battle.values().copied().collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let comp_by_event: HashMap<i64, i64> = if event_ids.is_empty() {
        HashMap::new()
    } else {
        event::Entity::find()
            .filter(event::Column::Id.is_in(event_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.comp_id))
            .collect()
    };

    let comp_ids: Vec<i64> = {
        let mut ids: Vec<i64> = comp_by_event.values().copied().collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let comp_names: HashMap<i64, String> = if comp_ids.is_empty() {
        HashMap::new()
    } else {
        comp::Entity::find()
            .filter(comp::Column::Id.is_in(comp_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|row| (row.id, row.name))
            .collect()
    };

    let mut cells: HashMap<(i64, i64), MatchupRow> = HashMap::new();
    // (scouted comp, fight) pairs already attributed to a cell. The first
    // battle segment of a fight to produce a resolved outcome+comp decides
    // that fight's contribution for that scout; later segments of the same
    // fight — whether they have an outcome or not — no longer change it, so
    // a fight is never double-counted and an unresolved sibling segment can
    // never erase (or duplicate) an already-resolved one.
    let mut decided: HashSet<(i64, FightKey)> = HashSet::new();
    let mut attributed_fights: HashSet<FightKey> = HashSet::new();

    for link in &links {
        let fight = fight_key_of(link.battle_id, &fight_id_by_battle);
        let group = (link.scouted_comp_id, fight);
        if decided.contains(&group) {
            continue;
        }
        let Some(event_id) = event_by_battle.get(&link.battle_id).copied() else {
            // No event association recorded yet for this segment — leave the
            // fight's attribution open for another segment to resolve;
            // absent, not a loss.
            continue;
        };
        let Some(comp_id) = comp_by_event.get(&event_id).copied() else {
            continue;
        };
        // An "unknown" outcome (never recomputed by `fight_analytics`) is
        // exactly as uninformative as a battle with no event association —
        // excluded from both wins and losses, not counted as a loss, and
        // left open for another segment to resolve the outcome later.
        let is_win = match fight {
            FightKey::Fight(fight_id) => {
                match outcome_by_fight.get(&fight_id).map(String::as_str) {
                    Some("victory") => true,
                    Some("defeat" | "draw") => false,
                    _ => continue,
                }
            }
            FightKey::UnmappedBattle(_) => continue,
        };
        decided.insert(group);
        attributed_fights.insert(fight);

        let cell = cells
            .entry((comp_id, link.scouted_comp_id))
            .or_insert_with(|| MatchupRow {
                our_comp_id: comp_id,
                our_comp_name: comp_names
                    .get(&comp_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Comp #{comp_id}")),
                scouted_comp_id: link.scouted_comp_id,
                battles: 0,
                wins: 0,
                losses: 0,
                win_rate: 0.0,
            });
        cell.battles += 1;
        if is_win {
            cell.wins += 1;
        } else {
            cell.losses += 1;
        }
    }

    let mut rows: Vec<MatchupRow> = cells.into_values().collect();
    for row in &mut rows {
        row.win_rate = ratio_percent(row.wins, row.battles);
    }
    rows.sort_by(|a, b| {
        b.battles
            .cmp(&a.battles)
            .then_with(|| a.our_comp_id.cmp(&b.our_comp_id))
            .then_with(|| a.scouted_comp_id.cmp(&b.scouted_comp_id))
    });

    let total_fights: HashSet<FightKey> = battle_ids
        .iter()
        .map(|id| fight_key_of(*id, &fight_id_by_battle))
        .collect();

    Ok(MatchupReport {
        coverage: MatchupCoverage {
            total_battles: total_fights.len() as i64,
            battles_with_comp: attributed_fights.len() as i64,
        },
        rows,
    })
}

/// Picks the composition that performs best against a given scout.
///
/// Ranked by win rate, with battle count as the tie-break so a single lucky win
/// does not outrank a comp with a sustained record. Returns `None` when nothing
/// has been fought against that scout yet.
#[must_use]
pub fn best_counter(rows: &[MatchupRow], scouted_comp_id: i64) -> Option<&MatchupRow> {
    rows.iter()
        .filter(|row| row.scouted_comp_id == scouted_comp_id && row.battles > 0)
        .max_by(|a, b| {
            a.win_rate
                .partial_cmp(&b.win_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.battles.cmp(&b.battles))
        })
}

/// Threat score for a scout: `losses * 2 + player_count`.
///
/// Losses are weighted double because an opponent that beats us matters more
/// than one we merely meet often, while headcount keeps a large untested ball
/// from ranking below a small familiar one.
#[must_use]
pub fn threat_score(rows: &[MatchupRow], scouted_comp_id: i64, player_count: i64) -> i64 {
    let losses: i64 = rows
        .iter()
        .filter(|row| row.scouted_comp_id == scouted_comp_id)
        .map(|row| row.losses)
        .sum();
    losses * 2 + player_count
}

#[cfg(test)]
mod tests {
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::intel::entities::scouted_comp;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    fn ts() -> sea_orm::prelude::DateTimeWithTimeZone {
        chrono::Utc::now().into()
    }

    /// A user row purely to satisfy `comps.created_by`/`events.created_by`
    /// foreign keys — its identity is irrelevant to these tests.
    async fn insert_user(db: &DatabaseConnection) -> i64 {
        crate::modules::users::entities::ActiveModel {
            username: Set("tester".to_string()),
            email: Set(format!("tester-{}@example.com", uuid::Uuid::new_v4())),
            role: Set("User".to_string()),
            created_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn insert_comp_category(db: &DatabaseConnection) -> i64 {
        crate::modules::comps::entities::comp_category::ActiveModel {
            name: Set("Category".to_string()),
            slug: Set(format!("category-{}", uuid::Uuid::new_v4())),
            created_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp category")
        .id
    }

    async fn insert_comp(db: &DatabaseConnection, name: &str) -> i64 {
        let created_by = insert_user(db).await;
        let category_id = insert_comp_category(db).await;
        comp::ActiveModel {
            name: Set(name.to_string()),
            category_id: Set(category_id),
            version: Set(1),
            created_by: Set(created_by),
            created_at: Set(ts()),
            updated_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp")
        .id
    }

    async fn insert_event(db: &DatabaseConnection, comp_id: i64) -> i64 {
        let created_by = insert_user(db).await;
        event::ActiveModel {
            title: Set("Test Event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(created_by),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event")
        .id
    }

    /// Links a raw `AlbionBB` battle segment to an event with a comp. Simply
    /// not calling this for a battle leaves it without an event association
    /// at all. Outcome no longer lives here — see `insert_fight`.
    async fn insert_event_battle(db: &DatabaseConnection, event_id: i64, battle_id: i64) {
        event_battle::ActiveModel {
            event_id: Set(event_id),
            albionbb_battle_id: Set(battle_id.to_string()),
            battle_started_at: Set(ts()),
            guild_players_count: Set(0),
            fetched_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event battle");
    }

    async fn insert_scouted_comp(db: &DatabaseConnection, name: &str) -> i64 {
        scouted_comp::ActiveModel {
            name: Set(name.to_string()),
            opponent_guild_name: Set("Enemy Guild".to_string()),
            category: Set("zerg".to_string()),
            player_count: Set(5),
            weapon_sample_size: Set(5),
            avg_ip: Set(1200.0),
            roles_json: Set("{}".to_string()),
            weapons_json: Set("{}".to_string()),
            players_json: Set("[]".to_string()),
            fingerprint: Set(format!("fp-{name}")),
            source_battle_count: Set(1),
            threat_score: Set(5),
            is_archived: Set(false),
            first_seen_at: Set(ts()),
            saved_at: Set(ts()),
            created_at: Set(ts()),
            updated_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert scouted comp")
        .id
    }

    async fn link_scout_battle(db: &DatabaseConnection, scouted_comp_id: i64, battle_id: i64) {
        scouted_comp_battle::ActiveModel {
            scouted_comp_id: Set(scouted_comp_id),
            battle_id: Set(battle_id),
            linked_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert scout link");
    }

    /// `outcome` is `fights.outcome`'s vocabulary: `"victory"`, `"defeat"`,
    /// `"draw"`, or `"unknown"` (never recomputed by `fight_analytics`).
    async fn insert_fight(db: &DatabaseConnection, outcome: &str) -> i64 {
        fight::ActiveModel {
            started_at: Set(ts()),
            outcome: Set(outcome.to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
        .id
    }

    async fn link_fight_battle(
        db: &DatabaseConnection,
        fight_id: i64,
        battle_id: i64,
        sequence_number: i32,
    ) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(sequence_number),
            created_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight battle");
    }

    /// Two `AlbionBB` battle segments of the same real engagement (one Fight),
    /// both linked to the scout and both resolving to the same comp/outcome
    /// via `event_battles`, must contribute to the matchup cell exactly once.
    #[tokio::test]
    async fn matchups_counts_two_segments_of_the_same_fight_as_one_battle() {
        let db = seed_db().await;
        let comp_id = insert_comp(&db, "Comp A").await;
        let event_id = insert_event(&db, comp_id).await;
        insert_event_battle(&db, event_id, 100).await;
        insert_event_battle(&db, event_id, 101).await;
        let scout_id = insert_scouted_comp(&db, "Scout A").await;
        link_scout_battle(&db, scout_id, 100).await;
        link_scout_battle(&db, scout_id, 101).await;
        let fight_id = insert_fight(&db, "victory").await;
        link_fight_battle(&db, fight_id, 100, 1).await;
        link_fight_battle(&db, fight_id, 101, 2).await;

        let report = matchups(&db, &[scout_id]).await.expect("matchups");

        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].battles, 1, "one fight, not two segments");
        assert_eq!(report.rows[0].wins, 1);
        assert_eq!(report.rows[0].losses, 0);
        assert_eq!(report.coverage.total_battles, 1);
        assert_eq!(report.coverage.battles_with_comp, 1);
    }

    /// The normal case: two battles belonging to two genuinely different
    /// fights must still count separately.
    #[tokio::test]
    async fn matchups_counts_battles_from_distinct_fights_separately() {
        let db = seed_db().await;
        let comp_id = insert_comp(&db, "Comp A").await;
        let event_id = insert_event(&db, comp_id).await;
        insert_event_battle(&db, event_id, 200).await;
        insert_event_battle(&db, event_id, 201).await;
        let scout_id = insert_scouted_comp(&db, "Scout A").await;
        link_scout_battle(&db, scout_id, 200).await;
        link_scout_battle(&db, scout_id, 201).await;
        let fight_a = insert_fight(&db, "victory").await;
        let fight_b = insert_fight(&db, "defeat").await;
        link_fight_battle(&db, fight_a, 200, 1).await;
        link_fight_battle(&db, fight_b, 201, 1).await;

        let report = matchups(&db, &[scout_id]).await.expect("matchups");

        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].battles, 2);
        assert_eq!(report.rows[0].wins, 1);
        assert_eq!(report.rows[0].losses, 1);
        assert_eq!(report.coverage.total_battles, 2);
        assert_eq!(report.coverage.battles_with_comp, 2);
    }

    /// A battle with no `event_battles` row at all is absent data, not a
    /// loss — unaffected by fight-level deduplication.
    #[tokio::test]
    async fn matchups_treats_unlinked_battle_as_absent_not_a_loss() {
        let db = seed_db().await;
        let scout_id = insert_scouted_comp(&db, "Scout A").await;
        link_scout_battle(&db, scout_id, 300).await;
        let fight_id = insert_fight(&db, "unknown").await;
        link_fight_battle(&db, fight_id, 300, 1).await;

        let report = matchups(&db, &[scout_id]).await.expect("matchups");

        assert!(
            report.rows.is_empty(),
            "no outcome yet => no row, not a loss"
        );
        assert_eq!(report.coverage.total_battles, 1);
        assert_eq!(report.coverage.battles_with_comp, 0);
    }

    /// If battle A of a fight has an event/comp association and sibling
    /// battle B of the same fight does not, the fight must still count
    /// exactly once (via A) — B's absence must not create a second, separate
    /// "absent" outcome for the same fight, nor prevent A's association from
    /// counting.
    #[tokio::test]
    async fn matchups_counts_a_fight_once_when_only_one_of_its_segments_has_an_association() {
        let db = seed_db().await;
        let comp_id = insert_comp(&db, "Comp A").await;
        let event_id = insert_event(&db, comp_id).await;
        // Only battle 400 gets an event_battles row; 401 never does.
        insert_event_battle(&db, event_id, 400).await;
        let scout_id = insert_scouted_comp(&db, "Scout A").await;
        link_scout_battle(&db, scout_id, 400).await;
        link_scout_battle(&db, scout_id, 401).await;
        let fight_id = insert_fight(&db, "victory").await;
        link_fight_battle(&db, fight_id, 400, 1).await;
        link_fight_battle(&db, fight_id, 401, 2).await;

        let report = matchups(&db, &[scout_id]).await.expect("matchups");

        assert_eq!(report.rows.len(), 1);
        assert_eq!(
            report.rows[0].battles, 1,
            "the fight counts once via its associated segment"
        );
        assert_eq!(report.rows[0].wins, 1);
        assert_eq!(report.coverage.total_battles, 1);
        assert_eq!(report.coverage.battles_with_comp, 1);
    }

    /// A Fight whose outcome has never been recomputed by `fight_analytics`
    /// (`"unknown"`) is exactly as uninformative as an unlinked battle: it
    /// must not contribute to either wins or losses, and must not be counted
    /// as attributed coverage either.
    #[tokio::test]
    async fn matchups_excludes_unknown_outcome_fight_from_wins_and_losses() {
        let db = seed_db().await;
        let comp_id = insert_comp(&db, "Comp A").await;
        let event_id = insert_event(&db, comp_id).await;
        insert_event_battle(&db, event_id, 500).await;
        let scout_id = insert_scouted_comp(&db, "Scout A").await;
        link_scout_battle(&db, scout_id, 500).await;
        let fight_id = insert_fight(&db, "unknown").await;
        link_fight_battle(&db, fight_id, 500, 1).await;

        let report = matchups(&db, &[scout_id]).await.expect("matchups");

        assert!(
            report.rows.is_empty(),
            "unknown outcome excluded, same as an unlinked battle"
        );
        assert_eq!(report.coverage.total_battles, 1);
        assert_eq!(
            report.coverage.battles_with_comp, 0,
            "not yet attributed while the outcome is unknown"
        );
    }

    fn row(comp: i64, scout: i64, wins: i64, losses: i64) -> MatchupRow {
        MatchupRow {
            our_comp_id: comp,
            our_comp_name: format!("Comp {comp}"),
            scouted_comp_id: scout,
            battles: wins + losses,
            wins,
            losses,
            win_rate: ratio_percent(wins, wins + losses),
        }
    }

    #[test]
    fn best_counter_prefers_the_higher_win_rate() {
        let rows = vec![row(1, 10, 1, 3), row(2, 10, 3, 1)];
        assert_eq!(best_counter(&rows, 10).unwrap().our_comp_id, 2);
    }

    /// A comp with the same win rate but more fights is the safer recommendation.
    #[test]
    fn best_counter_breaks_ties_on_sample_size() {
        let rows = vec![row(1, 10, 1, 0), row(2, 10, 4, 0)];
        assert_eq!(best_counter(&rows, 10).unwrap().our_comp_id, 2);
    }

    #[test]
    fn best_counter_is_none_without_data() {
        assert!(best_counter(&[], 10).is_none());
        assert!(best_counter(&[row(1, 99, 2, 0)], 10).is_none());
    }

    #[test]
    fn threat_weights_losses_double_and_adds_headcount() {
        let rows = vec![row(1, 10, 1, 3), row(2, 10, 0, 2)];
        // (3 + 2) losses * 2 + 20 players
        assert_eq!(threat_score(&rows, 10, 20), 30);
    }

    #[test]
    fn threat_of_an_unfought_scout_is_just_its_size() {
        assert_eq!(threat_score(&[], 10, 7), 7);
    }
}
