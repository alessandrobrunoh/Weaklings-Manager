//! Win/loss tallies of our compositions against scouted enemy compositions.
//!
//! The join runs scout → source battles → `event_battles` → event → comp. Only
//! battles that were linked to an event carry a comp, so a battle picked up by
//! the background sync but never attached to an event contributes a scout and
//! no matchup row. That is reported rather than hidden: officers who cannot see
//! why a matrix is sparse will assume the feature is broken.
//!
//! Outcomes come from the persisted `event_battles.is_win` and are never
//! recomputed here, so this module and the events module can never disagree.

use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::comps::entities::comp;
use crate::modules::events::entities::{event, event_battle};
use crate::modules::events::service::ratio_percent;
use crate::modules::intel::entities::scouted_comp_battle;

/// One cell of the matchup matrix: how one of our comps fares against one scout.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MatchupRow {
    /// Our composition's id.
    pub our_comp_id: i64,
    /// Our composition's name.
    pub our_comp_name: String,
    /// The scouted enemy composition's id.
    pub scouted_comp_id: i64,
    /// Battles counted in this cell.
    pub battles: i64,
    /// Battles won.
    pub wins: i64,
    /// Battles lost.
    pub losses: i64,
    /// Win percentage, 0-100.
    pub win_rate: f64,
}

/// Coverage information so callers can explain a sparse matrix.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct MatchupCoverage {
    /// Distinct battles linked to the scouts under consideration.
    pub total_battles: i64,
    /// How many of those resolved to one of our comps via an event.
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
/// cast would be Postgres-only and break the SQLite test backend.
///
/// A battle with no matching `event_battles` row is treated as *absent data*,
/// never as a loss — the background workers write snapshots and outcomes on
/// separate ticks, so a scout routinely exists before its outcome does.
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
    // Two-step join: integer ids stringified to match the event_battles column.
    let battle_id_strings: Vec<String> = battle_ids.iter().map(i64::to_string).collect();
    let event_battles = event_battle::Entity::find()
        .filter(event_battle::Column::AlbionbbBattleId.is_in(battle_id_strings))
        .all(db)
        .await?;

    // battle id -> (event id, won). A battle linked to several events keeps the
    // first association, which is the same rule the events module applies.
    let mut outcome_by_battle: HashMap<i64, (i64, bool)> = HashMap::new();
    for row in &event_battles {
        let Ok(battle_id) = row.albionbb_battle_id.parse::<i64>() else {
            continue;
        };
        outcome_by_battle
            .entry(battle_id)
            .or_insert((row.event_id, row.is_win));
    }

    let event_ids: Vec<i64> = {
        let mut ids: Vec<i64> = outcome_by_battle.values().map(|(id, _)| *id).collect();
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
    let mut attributed_battles: HashSet<i64> = HashSet::new();

    for link in &links {
        let Some((event_id, is_win)) = outcome_by_battle.get(&link.battle_id).copied() else {
            // No outcome recorded yet — absent, not a loss.
            continue;
        };
        let Some(comp_id) = comp_by_event.get(&event_id).copied() else {
            continue;
        };
        attributed_battles.insert(link.battle_id);

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

    Ok(MatchupReport {
        coverage: MatchupCoverage {
            total_battles: battle_ids.len() as i64,
            battles_with_comp: attributed_battles.len() as i64,
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
    use super::*;

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
