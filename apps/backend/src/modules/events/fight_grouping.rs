//! Conservative, deterministic evidence scoring for grouping battle records.
//!
//! This module is intentionally pure: callers supply normalized evidence and
//! decide how to persist or present the resulting recommendation.

use chrono::{DateTime, Duration, Utc};
use std::collections::BTreeSet;

/// Version of the deterministic fight-grouping rules.
pub const FIGHT_GROUPING_VERSION: &str = "1";

/// The largest permitted non-overlapping interval between two fights.
pub const MAX_FIGHT_GAP: Duration = Duration::minutes(20);

/// Evidence that can associate one battle record with a larger fight.
///
/// Identity values should be stable, normalized identifiers where possible.
/// Ordered sets make equality and overlap calculations deterministic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FightEvidence {
    /// The event session associated with this record, if known.
    pub event_id: Option<i64>,
    /// When the battle began, if known.
    pub started_at: Option<DateTime<Utc>>,
    /// When the battle ended, if known.
    pub ended_at: Option<DateTime<Utc>>,
    /// Guild identities on the friendly side.
    pub friendly_guild_ids: BTreeSet<String>,
    /// Guild identities on the opposing side.
    pub opponent_guild_ids: BTreeSet<String>,
    /// Player identities observed in the battle.
    pub player_ids: BTreeSet<String>,
    /// Number of players observed, if the source provides it.
    pub size: Option<usize>,
}

/// The recommended handling for two battle records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FightGroupingDecision {
    /// The evidence is strong enough to group records without human review.
    AutoMerge,
    /// The evidence is plausible but requires a human decision.
    NeedsReview,
    /// The evidence is insufficient to group the records.
    Separate,
}

/// The deterministic score and recommendation for a pair of battle records.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FightGroupingResult {
    /// Version of the rule set used to calculate this result.
    pub version: &'static str,
    /// Confidence in the `0.0..=1.0` range.
    pub score: f64,
    /// Recommended disposition for the record pair.
    pub decision: FightGroupingDecision,
}

/// Scores whether two battle records should represent the same fight.
///
/// Different known event IDs, missing timestamps, invalid timestamp ranges, and
/// a gap over [`MAX_FIGHT_GAP`] always result in [`FightGroupingDecision::Separate`].
/// Missing optional identity evidence contributes no score; it is never treated
/// as contradictory evidence.
#[must_use]
pub fn score_fight_grouping(left: &FightEvidence, right: &FightEvidence) -> FightGroupingResult {
    if has_hard_no_merge(left, right) {
        return result(0.0);
    }

    let mut score = event_score(left.event_id, right.event_id);
    score += timing_score(left, right);
    score += 0.18 * overlap_ratio(&left.friendly_guild_ids, &right.friendly_guild_ids);
    score += 0.16 * overlap_ratio(&left.opponent_guild_ids, &right.opponent_guild_ids);
    score += 0.26 * overlap_ratio(&left.player_ids, &right.player_ids);
    score += size_score(left.size, right.size);

    result(score)
}

fn has_hard_no_merge(left: &FightEvidence, right: &FightEvidence) -> bool {
    matches!(
        (left.event_id, right.event_id),
        (Some(left_id), Some(right_id)) if left_id != right_id
    ) || !has_valid_times(left)
        || !has_valid_times(right)
        || gap_between(left, right).is_some_and(|gap| gap > MAX_FIGHT_GAP)
}

fn has_valid_times(evidence: &FightEvidence) -> bool {
    matches!(
        (evidence.started_at, evidence.ended_at),
        (Some(started_at), Some(ended_at)) if ended_at >= started_at
    )
}

fn gap_between(left: &FightEvidence, right: &FightEvidence) -> Option<Duration> {
    let left_start = left.started_at?;
    let left_end = left.ended_at?;
    let right_start = right.started_at?;
    let right_end = right.ended_at?;

    Some(if left_end < right_start {
        right_start - left_end
    } else if right_end < left_start {
        left_start - right_end
    } else {
        Duration::zero()
    })
}

fn event_score(left: Option<i64>, right: Option<i64>) -> f64 {
    if matches!((left, right), (Some(left_id), Some(right_id)) if left_id == right_id) {
        0.60
    } else {
        0.0
    }
}

fn timing_score(left: &FightEvidence, right: &FightEvidence) -> f64 {
    match gap_between(left, right) {
        Some(gap) if gap == Duration::zero() => 0.20,
        Some(gap) if gap <= Duration::minutes(5) => 0.18,
        Some(_) => 0.15,
        None => 0.0,
    }
}

fn overlap_ratio(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }

    let intersection = left.intersection(right).count();
    let union = left.union(right).count();
    intersection as f64 / union as f64
}

fn size_score(left: Option<usize>, right: Option<usize>) -> f64 {
    match (left, right) {
        (Some(left_size), Some(right_size)) if left_size > 0 && right_size > 0 => {
            let largest = left_size.max(right_size) as f64;
            0.10 * (1.0 - (left_size.abs_diff(right_size) as f64 / largest))
        }
        _ => 0.0,
    }
}

fn result(score: f64) -> FightGroupingResult {
    let decision = if score >= 0.80 {
        FightGroupingDecision::AutoMerge
    } else if score >= 0.55 {
        FightGroupingDecision::NeedsReview
    } else {
        FightGroupingDecision::Separate
    };

    FightGroupingResult {
        version: FIGHT_GROUPING_VERSION,
        score,
        decision,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(start_offset_minutes: i64, end_offset_minutes: i64) -> FightEvidence {
        let start = DateTime::parse_from_rfc3339("2026-09-01T20:00:00Z")
            .expect("valid fixed test timestamp")
            .with_timezone(&Utc);

        FightEvidence {
            event_id: None,
            started_at: Some(start + Duration::minutes(start_offset_minutes)),
            ended_at: Some(start + Duration::minutes(end_offset_minutes)),
            friendly_guild_ids: BTreeSet::new(),
            opponent_guild_ids: BTreeSet::new(),
            player_ids: BTreeSet::new(),
            size: None,
        }
    }

    fn identities(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn grouping_is_deterministic() {
        let mut left = evidence(0, 10);
        left.event_id = Some(42);
        left.player_ids = identities(&["player-a", "player-b"]);
        let mut right = evidence(8, 18);
        right.event_id = Some(42);
        right.player_ids = identities(&["player-a", "player-c"]);

        assert_eq!(
            score_fight_grouping(&left, &right),
            score_fight_grouping(&left, &right)
        );
    }

    #[test]
    fn twenty_minute_gap_is_allowed_but_larger_gap_is_not() {
        let mut left = evidence(0, 10);
        left.event_id = Some(7);
        let mut at_boundary = evidence(30, 40);
        at_boundary.event_id = Some(7);
        let mut beyond_boundary = evidence(31, 41);
        beyond_boundary.event_id = Some(7);

        assert_eq!(
            score_fight_grouping(&left, &at_boundary).decision,
            FightGroupingDecision::NeedsReview
        );
        assert_eq!(
            score_fight_grouping(&left, &beyond_boundary).decision,
            FightGroupingDecision::Separate
        );
    }

    #[test]
    fn different_known_events_never_merge() {
        let mut left = evidence(0, 10);
        left.event_id = Some(1);
        let mut right = evidence(8, 18);
        right.event_id = Some(2);
        right.friendly_guild_ids = identities(&["friendly"]);
        right.opponent_guild_ids = identities(&["opponent"]);
        right.player_ids = identities(&["player-a"]);

        assert_eq!(
            score_fight_grouping(&left, &right).decision,
            FightGroupingDecision::Separate
        );
    }

    #[test]
    fn overlapping_guilds_and_players_auto_merge() {
        let mut left = evidence(0, 10);
        left.friendly_guild_ids = identities(&["friendly"]);
        left.opponent_guild_ids = identities(&["opponent"]);
        left.player_ids = identities(&["player-a", "player-b"]);
        left.size = Some(20);

        let mut right = evidence(8, 18);
        right.friendly_guild_ids = identities(&["friendly"]);
        right.opponent_guild_ids = identities(&["opponent"]);
        right.player_ids = identities(&["player-a", "player-b"]);
        right.size = Some(20);

        let result = score_fight_grouping(&left, &right);
        assert!(result.score >= 0.80);
        assert_eq!(result.decision, FightGroupingDecision::AutoMerge);
    }

    #[test]
    fn partial_evidence_requires_review() {
        let mut left = evidence(0, 10);
        left.friendly_guild_ids = identities(&["friendly"]);
        left.player_ids = identities(&["player-a", "player-b"]);

        let mut right = evidence(12, 22);
        right.friendly_guild_ids = identities(&["friendly"]);
        right.player_ids = identities(&["player-a", "player-b"]);

        let result = score_fight_grouping(&left, &right);
        assert!((0.55..0.80).contains(&result.score));
        assert_eq!(result.decision, FightGroupingDecision::NeedsReview);
    }
}
