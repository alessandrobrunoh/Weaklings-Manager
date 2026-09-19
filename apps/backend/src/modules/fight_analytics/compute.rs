//! Pure aggregation of one canonical Fight's already-persisted, multi-segment
//! evidence into one decided outcome and one set of deduplicated analytics.
//!
//! This module does no I/O: it takes plain evidence structs the caller has
//! already gathered from `battle_guild_stats`, `battle_player_stats` and
//! `battle_loss_estimates` across every segment (`battle_id`) belonging to a
//! Fight, and returns a plain result struct. See the parent module's doc
//! comment for why the outcome and the stats it produces are recomputed here
//! rather than re-derived ad hoc on every read.
//!
//! Two things this module is careful to get right, both already fixed
//! elsewhere and simply reused here rather than reimplemented:
//! - **One outcome, one rule.** [`crate::modules::battles::outcome::classify`]
//!   and [`crate::modules::battles::outcome::combine_segments`] are the sole
//!   source of truth for "did we win"; this module only shapes the evidence
//!   it is given into their input types (`SideRollup`, `OutcomeVerdict`) using
//!   the `is_friendly` flag each row already carries, rather than re-deriving
//!   friendliness from a guild id/name and a `FriendlySide` a second time.
//! - **Player identity vs. per-segment contribution.** A player who fought in
//!   two segments of the same Fight produces two [`PlayerAppearance`] rows —
//!   one per segment — on purpose. Only the *count* of distinct players is
//!   deduplicated (via `player_key`); every appearance's kills, deaths, fame
//!   and item power still contributes to the sums and averages, because the
//!   player really did fight (and could die, or land kills) independently in
//!   each segment. Deduplicating those per-appearance numbers as well would
//!   silently drop real combat contribution, which is the double-counting
//!   bug in the opposite direction from the one this module exists to fix.

use std::collections::HashSet;

use crate::modules::battles::outcome::{
    BattleOutcome, OutcomeVerdict, SideRollup, classify, combine_segments,
};

/// Mirrors the fields of one `battle_guild_stats` row needed here.
#[derive(Debug, Clone, Copy)]
pub struct SegmentGuildLine {
    pub is_friendly: bool,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    pub winner: bool,
}

/// One segment (`AlbionBB` battle) belonging to the fight: its guild rows and
/// total fame, enough to classify this one segment's outcome.
#[derive(Debug, Clone)]
pub struct FightSegment {
    /// Carried through for the caller's own correlation/debugging — this
    /// module's aggregation never needs to read it back, since a segment's
    /// contribution is fully determined by its `total_fame`/`guilds`.
    #[allow(dead_code)]
    pub battle_id: i64,
    pub total_fame: i64,
    pub guilds: Vec<SegmentGuildLine>,
}

/// Mirrors the fields of one `battle_player_stats` row needed here. One row
/// per (`battle_id`, player) appearance — the same player fighting in two
/// segments produces two of these, on purpose (see the module docs on why
/// their stats are summed, not deduplicated, while only their *identity* is).
#[derive(Debug, Clone)]
pub struct PlayerAppearance {
    pub player_key: String,
    pub is_friendly: bool,
    pub kills: i32,
    pub deaths: i32,
    pub kill_fame: i64,
    pub item_power: f64,
}

/// Mirrors one `battle_loss_estimates` row for one segment.
#[derive(Debug, Clone, Copy)]
pub struct SegmentLossEstimate {
    pub friendly_estimated_loss: i64,
    pub enemy_estimated_loss: i64,
}

/// One Fight's fully aggregated, deduplicated analytics.
#[derive(Debug, Clone, PartialEq)]
pub struct FightAnalytics {
    pub outcome: BattleOutcome,
    pub outcome_method: String,
    pub segment_count: i32,
    pub unique_friendly_players: i32,
    pub unique_enemy_players: i32,
    pub friendly_kills: i64,
    pub friendly_deaths: i64,
    pub friendly_kill_fame: i64,
    pub enemy_kills: i64,
    pub enemy_deaths: i64,
    pub enemy_kill_fame: i64,
    pub avg_friendly_item_power: f64,
    pub avg_enemy_item_power: f64,
    pub friendly_estimated_loss: i64,
    /// A trade indicator only — see the module docs on `economy`'s
    /// income-is-declared-never-inferred rule, which this field must never
    /// violate downstream.
    pub enemy_estimated_loss: i64,
}

/// Builds one segment's friendly-side [`SideRollup`] directly from its
/// already-classified guild rows, since `is_friendly` is already known and
/// there is no need to re-derive it from a guild id/name.
fn friendly_rollup(segment: &FightSegment) -> SideRollup {
    let mut rollup = SideRollup::default();
    for guild in segment.guilds.iter().filter(|guild| guild.is_friendly) {
        rollup.resolved = true;
        rollup.guilds += 1;
        rollup.kills += guild.kills;
        rollup.deaths += guild.deaths;
        rollup.kill_fame += guild.kill_fame;
        if guild.winner {
            rollup.crowned_winner = true;
        }
    }
    rollup
}

/// One side's summed stats and item-power average across every appearance on
/// that side, plus its count of distinct players.
struct SideTotals {
    unique_players: i32,
    kills: i64,
    deaths: i64,
    kill_fame: i64,
    avg_item_power: f64,
}

/// Sums every appearance on one side (`is_friendly == side`) and counts its
/// distinct `player_key`s.
///
/// Kills, deaths, fame and item power are summed/averaged across every
/// appearance, never deduplicated — matching `fights.rs`'s existing
/// `PlayerRollup` precedent, where a player who appears in multiple segments
/// really did contribute in each one. Only `unique_players` deduplicates.
#[allow(
    clippy::cast_precision_loss,
    reason = "appearance_count is a small real-world roster count, never near f64's precision limit"
)]
fn side_totals(appearances: &[PlayerAppearance], side: bool) -> SideTotals {
    let mut keys = HashSet::new();
    let mut kills: i64 = 0;
    let mut deaths: i64 = 0;
    let mut kill_fame: i64 = 0;
    let mut item_power_total = 0.0_f64;
    let mut appearance_count: i64 = 0;

    for appearance in appearances.iter().filter(|a| a.is_friendly == side) {
        keys.insert(appearance.player_key.as_str());
        kills += i64::from(appearance.kills);
        deaths += i64::from(appearance.deaths);
        kill_fame += appearance.kill_fame;
        item_power_total += appearance.item_power;
        appearance_count += 1;
    }

    let avg_item_power = if appearance_count > 0 {
        item_power_total / appearance_count as f64
    } else {
        0.0
    };

    SideTotals {
        unique_players: i32::try_from(keys.len()).unwrap_or(i32::MAX),
        kills,
        deaths,
        kill_fame,
        avg_item_power,
    }
}

/// Aggregates one canonical Fight's multi-segment evidence into its decided
/// outcome and deduplicated analytics.
///
/// # Behavior
/// - Outcome: each segment's friendly guild rows are rolled up into a
///   [`SideRollup`] and classified independently via
///   [`crate::modules::battles::outcome::classify`]; the per-segment verdicts
///   are then combined via
///   [`crate::modules::battles::outcome::combine_segments`], which is the
///   sole source of truth for how partial or conflicting segment evidence
///   resolves to one Fight-level outcome.
/// - Player stats: `unique_*_players` deduplicates by `player_key`; every
///   other per-side number sums or averages across every appearance,
///   deliberately not deduplicated (see the module docs).
/// - Loss estimates: summed across every segment's already-deduplicated
///   `battle_loss_estimates` row, unchanged otherwise.
#[must_use]
pub fn compute_fight_analytics(
    segments: &[FightSegment],
    player_appearances: &[PlayerAppearance],
    loss_estimates: &[SegmentLossEstimate],
) -> FightAnalytics {
    let verdicts: Vec<OutcomeVerdict> = segments
        .iter()
        .map(|segment| classify(&friendly_rollup(segment), segment.total_fame))
        .collect();
    let fight_verdict = combine_segments(&verdicts);

    let friendly = side_totals(player_appearances, true);
    let enemy = side_totals(player_appearances, false);

    let (friendly_estimated_loss, enemy_estimated_loss) =
        loss_estimates
            .iter()
            .fold((0_i64, 0_i64), |(friendly_acc, enemy_acc), estimate| {
                (
                    friendly_acc + estimate.friendly_estimated_loss,
                    enemy_acc + estimate.enemy_estimated_loss,
                )
            });

    FightAnalytics {
        outcome: fight_verdict.outcome,
        outcome_method: fight_verdict.method,
        segment_count: i32::try_from(segments.len()).unwrap_or(i32::MAX),
        unique_friendly_players: friendly.unique_players,
        unique_enemy_players: enemy.unique_players,
        friendly_kills: friendly.kills,
        friendly_deaths: friendly.deaths,
        friendly_kill_fame: friendly.kill_fame,
        enemy_kills: enemy.kills,
        enemy_deaths: enemy.deaths,
        enemy_kill_fame: enemy.kill_fame,
        avg_friendly_item_power: friendly.avg_item_power,
        avg_enemy_item_power: enemy.avg_item_power,
        friendly_estimated_loss,
        enemy_estimated_loss,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn friendly_guild(kills: i64, deaths: i64, kill_fame: i64, winner: bool) -> SegmentGuildLine {
        SegmentGuildLine {
            is_friendly: true,
            kills,
            deaths,
            kill_fame,
            winner,
        }
    }

    fn enemy_guild(kills: i64, deaths: i64, kill_fame: i64, winner: bool) -> SegmentGuildLine {
        SegmentGuildLine {
            is_friendly: false,
            kills,
            deaths,
            kill_fame,
            winner,
        }
    }

    fn appearance(
        player_key: &str,
        is_friendly: bool,
        kills: i32,
        deaths: i32,
        kill_fame: i64,
        item_power: f64,
    ) -> PlayerAppearance {
        PlayerAppearance {
            player_key: player_key.to_string(),
            is_friendly,
            kills,
            deaths,
            kill_fame,
            item_power,
        }
    }

    /// A single-segment fight with a clear friendly win produces `Victory`
    /// via the `fame_lead` branch, and that reaches `combine_segments`'s
    /// single-element `"unanimous_segments"` path unchanged.
    #[test]
    fn single_segment_clear_win_is_victory_via_unanimous_segments() {
        let segments = vec![FightSegment {
            battle_id: 1,
            total_fame: 1_000_000,
            guilds: vec![
                friendly_guild(8, 2, 600_000, false),
                enemy_guild(2, 8, 400_000, false),
            ],
        }];

        let analytics = compute_fight_analytics(&segments, &[], &[]);

        assert_eq!(analytics.outcome, BattleOutcome::Victory);
        assert_eq!(analytics.outcome_method, "unanimous_segments");
        assert_eq!(analytics.segment_count, 1);
    }

    /// A multi-segment fight where every segment agrees combines to the
    /// unanimous outcome. The expected shape is cross-checked directly
    /// against `combine_segments` fed the same per-segment verdicts, rather
    /// than a hand-rolled expectation.
    #[test]
    fn multi_segment_unanimous_fight_matches_combine_segments_directly() {
        let segments = vec![
            FightSegment {
                battle_id: 1,
                total_fame: 1_000_000,
                guilds: vec![
                    friendly_guild(8, 2, 600_000, false),
                    enemy_guild(2, 8, 400_000, false),
                ],
            },
            FightSegment {
                battle_id: 2,
                total_fame: 500_000,
                guilds: vec![
                    friendly_guild(5, 1, 300_000, false),
                    enemy_guild(1, 5, 200_000, false),
                ],
            },
        ];

        let analytics = compute_fight_analytics(&segments, &[], &[]);

        let expected = combine_segments(&[
            classify(&friendly_rollup(&segments[0]), segments[0].total_fame),
            classify(&friendly_rollup(&segments[1]), segments[1].total_fame),
        ]);
        assert_eq!(analytics.outcome, expected.outcome);
        assert_eq!(analytics.outcome_method, expected.method);
        assert_eq!(analytics.outcome, BattleOutcome::Victory);
        assert_eq!(analytics.segment_count, 2);
    }

    /// The core bug fix, proven explicitly: the same player fighting in two
    /// segments must count as ONE unique player, while their kills/deaths
    /// from both segments must still both be counted — they really did
    /// fight (and land kills, and die) independently in each segment. This
    /// is the exact double-counting bug this module exists to fix, in the
    /// direction of never under- or over-counting either quantity.
    #[test]
    fn same_player_across_two_segments_is_deduplicated_by_identity_not_by_stats() {
        let appearances = vec![
            appearance("id:p1", true, 3, 1, 100_000, 900.0),
            appearance("id:p1", true, 2, 4, 50_000, 900.0),
        ];

        let analytics = compute_fight_analytics(&[], &appearances, &[]);

        // Identity is deduplicated: one distinct player_key, one player.
        assert_eq!(
            analytics.unique_friendly_players, 1,
            "the same player_key across two segments must not be double-counted as two players"
        );
        // Per-segment contributions are NOT deduplicated: both appearances'
        // kills/deaths really happened and must both be summed.
        assert_eq!(
            analytics.friendly_kills, 5,
            "3 + 2 kills across both segments"
        );
        assert_eq!(
            analytics.friendly_deaths, 5,
            "1 + 4 deaths across both segments"
        );
        assert_eq!(
            analytics.friendly_kill_fame, 150_000,
            "100_000 + 50_000 fame across both segments"
        );
    }

    /// Average item power is the mean across every appearance, not a
    /// per-unique-player mean: two friendly players, one of whom appears in
    /// two segments with very different item power, must weight that
    /// player's two appearances independently. A per-unique-player mean
    /// would average (900 + 100)/2 = 500 for that one player, then average
    /// again with the other player; the appearance-based mean here
    /// deliberately differs from that.
    #[test]
    fn average_item_power_is_over_every_appearance_not_per_unique_player() {
        let appearances = vec![
            // "id:p1" appears twice: once at 900 item power, once at 100.
            appearance("id:p1", true, 1, 0, 10_000, 900.0),
            appearance("id:p1", true, 0, 1, 0, 100.0),
            // "id:p2" appears once, at 200 item power.
            appearance("id:p2", true, 0, 0, 0, 200.0),
        ];

        let analytics = compute_fight_analytics(&[], &appearances, &[]);

        assert_eq!(analytics.unique_friendly_players, 2);
        // Appearance-based mean over 3 appearances: (900 + 100 + 200) / 3.
        let expected_appearance_mean = (900.0 + 100.0 + 200.0) / 3.0;
        assert!((analytics.avg_friendly_item_power - expected_appearance_mean).abs() < 1e-9);

        // A per-unique-player mean would instead average p1's own two
        // appearances first ((900+100)/2 = 500), then average with p2's 200,
        // landing on 350 — deliberately different from the appearance mean.
        let per_unique_player_mean = (500.0 + 200.0) / 2.0;
        assert!((analytics.avg_friendly_item_power - per_unique_player_mean).abs() > 1.0);
    }

    /// Zero appearances on one side must produce a zero count and a zero
    /// average, never a panic or NaN from dividing by zero.
    #[test]
    fn zero_appearances_on_one_side_is_zero_not_nan() {
        let appearances = vec![appearance("id:p1", true, 4, 0, 200_000, 1000.0)];

        let analytics = compute_fight_analytics(&[], &appearances, &[]);

        assert_eq!(analytics.unique_enemy_players, 0);
        assert_eq!(analytics.enemy_kills, 0);
        assert_eq!(analytics.enemy_deaths, 0);
        assert_eq!(analytics.enemy_kill_fame, 0);
        assert_eq!(analytics.avg_enemy_item_power, 0.0);
        assert!(!analytics.avg_enemy_item_power.is_nan());
    }

    /// Loss estimates from multiple segments sum correctly, and
    /// `enemy_estimated_loss` passes through unchanged — this module never
    /// transforms it, consistent with the trade-indicator-only rule.
    #[test]
    fn loss_estimates_sum_across_segments_unchanged() {
        let estimates = vec![
            SegmentLossEstimate {
                friendly_estimated_loss: 100_000,
                enemy_estimated_loss: 250_000,
            },
            SegmentLossEstimate {
                friendly_estimated_loss: 40_000,
                enemy_estimated_loss: 10_000,
            },
        ];

        let analytics = compute_fight_analytics(&[], &[], &estimates);

        assert_eq!(analytics.friendly_estimated_loss, 140_000);
        assert_eq!(analytics.enemy_estimated_loss, 260_000);
    }

    /// Zero segments at all must match `combine_segments(&[])`'s own answer
    /// directly, rather than a separately hand-rolled expectation.
    #[test]
    fn zero_segments_matches_combine_segments_empty_case() {
        let analytics = compute_fight_analytics(&[], &[], &[]);

        let expected = combine_segments(&[]);
        assert_eq!(analytics.segment_count, 0);
        assert_eq!(analytics.outcome, expected.outcome);
        assert_eq!(analytics.outcome_method, expected.method);
        assert_eq!(analytics.outcome, BattleOutcome::Unknown);
        assert_eq!(analytics.outcome_method, "no_segments");
    }
}
