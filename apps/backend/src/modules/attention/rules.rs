//! Pure, deterministic attention-signal rules (plan §7).
//!
//! Every function here takes already-aggregated inputs (no database access
//! — `attention::writer` owns every query) and returns `Option<Finding>`:
//! `None` when the rule's minimum-sample gate isn't met or its condition
//! doesn't hold, `Some` otherwise. No natural-language text is ever
//! produced — `evidence` is numbers and identifiers only; rendering a
//! sentence from `rule_key` + `evidence` is a read-side concern.
//!
//! # Scope of this first pass
//!
//! Plan §7 catalogs fifteen rules. This module implements the six that are
//! computable today from infrastructure already built and verified in
//! Phases 0–5 (`fights.outcome`, `fight_stats`, `battle_loss_estimates`,
//! `enemy_guilds`/`enemy_player_battles`), with no new prerequisite
//! plumbing:
//!
//! - `win_rate_drop`, `trade_worsening`, `ip_deficit` — from `fight_stats`
//!   joined to `fights` by period.
//! - `unpriced_losses` — from `battle_loss_estimates` joined through
//!   `fight_battles` to `fights` by period.
//! - `attribution_gap` — from `fights.event_id` alone.
//! - `stale_intel` — from `enemy_guilds.last_seen_at` and distinct
//!   `enemy_player_battles.battle_id` counts.
//!
//! The other nine (`backline_collapse`, `comp_adherence_low`,
//! `bad_matchup`, `regear_without_attendance`, `bank_negative_streak`,
//! `player_regression`, `roster_shrink`, `prime_time_mismatch`,
//! `first_death_repeat`) each need a prerequisite this codebase does not
//! yet have — a fight-to-enemy-guild association table
//! (`fight_opponents`), friendly-player identity resolution on the L0
//! evidence tables, or a weekly economy rollup — and are deliberately left
//! for a later pass rather than approximated.
//!
//! # Two declared minimum-sample floors not in the plan's own table
//!
//! Plan §7 lists no minimum sample for `unpriced_losses` and
//! `attribution_gap` (`—`in the table). That table's own header rule is
//! "nessun alert sotto la soglia di campione" (no alert below the minimum
//! sample threshold), which is meaningless without *some* floor, so this
//! module sets one explicitly for both — documented on each function below
//! — rather than alerting on, say, a single unpriced item stack right after
//! a tenant's first battle.

use chrono::{DateTime, Utc};
use serde_json::json;

/// One rule's output: everything `attention::writer` needs to persist a row,
/// with no natural-language content.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub rule_key: &'static str,
    pub rule_version: i32,
    pub severity: Severity,
    pub subject_type: &'static str,
    pub subject_id: Option<i64>,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub metric_value: f64,
    pub baseline_value: Option<f64>,
    pub sample_size: i32,
    pub evidence: serde_json::Value,
}

/// `attention_findings.severity`'s vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    High,
    Medium,
    Info,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Info => "info",
        }
    }
}

/// One period's decided-outcome fight counts, for `win_rate_drop`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeriodOutcomes {
    /// Fights with a decided outcome (`victory`/`defeat`/`draw`) in this
    /// period — a fight never recomputed (`outcome = "unknown"`) is
    /// excluded from both numerator and denominator, since it would
    /// otherwise silently count as a loss.
    pub decided_fights: i64,
    pub wins: i64,
}

/// One period's silver/fame totals, for `trade_worsening`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeriodTrade {
    pub fights: i64,
    pub friendly_estimated_loss_total: i64,
    pub friendly_kill_fame_total: i64,
}

/// One fight's average item power on each side, for `ip_deficit`.
#[derive(Debug, Clone, Copy)]
pub struct FightIpSample {
    pub avg_friendly_item_power: f64,
    pub avg_enemy_item_power: f64,
}

const RULE_VERSION: i32 = 1;

/// `win_rate_drop`: win rate over the current period fell at least 10
/// points versus the previous period. Minimum sample: 8 decided fights in
/// *each* period (plan §7, rule 1).
#[allow(
    clippy::cast_precision_loss,
    reason = "decided_fights/wins are guild-scale fight counts, orders of magnitude below f64's precision limit"
)]
pub fn evaluate_win_rate_drop(
    current: PeriodOutcomes,
    previous: PeriodOutcomes,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_SAMPLE: i64 = 8;
    if current.decided_fights < MIN_SAMPLE || previous.decided_fights < MIN_SAMPLE {
        return None;
    }
    let current_rate = current.wins as f64 / current.decided_fights as f64 * 100.0;
    let previous_rate = previous.wins as f64 / previous.decided_fights as f64 * 100.0;
    let drop = previous_rate - current_rate;
    if drop < 10.0 {
        return None;
    }
    Some(Finding {
        rule_key: "win_rate_drop",
        rule_version: RULE_VERSION,
        severity: if drop >= 20.0 {
            Severity::High
        } else {
            Severity::Medium
        },
        subject_type: "guild",
        subject_id: None,
        period_start,
        period_end,
        metric_value: current_rate,
        baseline_value: Some(previous_rate),
        sample_size: i32::try_from(current.decided_fights).unwrap_or(i32::MAX),
        evidence: json!({
            "current_fights": current.decided_fights,
            "current_wins": current.wins,
            "current_win_rate": current_rate,
            "previous_fights": previous.decided_fights,
            "previous_wins": previous.wins,
            "previous_win_rate": previous_rate,
            "drop_points": drop,
        }),
    })
}

/// `trade_worsening`: silver lost per fight rose at least 25% while kill
/// fame per fight stayed within ±10%. Minimum sample: 8 fights in *each*
/// period (plan §7, rule 2).
#[allow(
    clippy::cast_precision_loss,
    reason = "fight counts and silver/fame totals here are guild-scale, orders of magnitude below f64's precision limit"
)]
pub fn evaluate_trade_worsening(
    current: PeriodTrade,
    previous: PeriodTrade,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_SAMPLE: i64 = 8;
    if current.fights < MIN_SAMPLE || previous.fights < MIN_SAMPLE {
        return None;
    }
    // A previous period with zero recorded loss/fame has no meaningful
    // percentage change to compare against — skip rather than divide by
    // zero or report a nonsensical "infinite" increase.
    if previous.friendly_estimated_loss_total <= 0 || previous.friendly_kill_fame_total <= 0 {
        return None;
    }

    let silver_per_fight_cur = current.friendly_estimated_loss_total as f64 / current.fights as f64;
    let silver_per_fight_prev =
        previous.friendly_estimated_loss_total as f64 / previous.fights as f64;
    let fame_per_fight_cur = current.friendly_kill_fame_total as f64 / current.fights as f64;
    let fame_per_fight_prev = previous.friendly_kill_fame_total as f64 / previous.fights as f64;

    let silver_change_pct =
        (silver_per_fight_cur - silver_per_fight_prev) / silver_per_fight_prev * 100.0;
    let fame_change_pct = (fame_per_fight_cur - fame_per_fight_prev) / fame_per_fight_prev * 100.0;

    if silver_change_pct < 25.0 || fame_change_pct.abs() > 10.0 {
        return None;
    }

    Some(Finding {
        rule_key: "trade_worsening",
        rule_version: RULE_VERSION,
        severity: if silver_change_pct >= 50.0 {
            Severity::High
        } else {
            Severity::Medium
        },
        subject_type: "guild",
        subject_id: None,
        period_start,
        period_end,
        metric_value: silver_per_fight_cur,
        baseline_value: Some(silver_per_fight_prev),
        sample_size: i32::try_from(current.fights).unwrap_or(i32::MAX),
        evidence: json!({
            "current_fights": current.fights,
            "current_silver_per_fight": silver_per_fight_cur,
            "current_fame_per_fight": fame_per_fight_cur,
            "previous_fights": previous.fights,
            "previous_silver_per_fight": silver_per_fight_prev,
            "previous_fame_per_fight": fame_per_fight_prev,
            "silver_change_pct": silver_change_pct,
            "fame_change_pct": fame_change_pct,
        }),
    })
}

/// `ip_deficit`: average item-power delta (friendly − enemy) across recent
/// fights is at or below −50. Averaged per fight, unweighted by player
/// count — each fight counts once, matching plan §7's "delta IP medio" at
/// fight granularity, not player granularity. Minimum sample: 5 fights
/// (plan §7, rule 3).
#[allow(
    clippy::cast_precision_loss,
    reason = "samples.len() is a fight count in the single digits to low hundreds, orders of magnitude below f64's precision limit"
)]
pub fn evaluate_ip_deficit(
    samples: &[FightIpSample],
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_SAMPLE: usize = 5;
    if samples.len() < MIN_SAMPLE {
        return None;
    }
    let deltas: Vec<f64> = samples
        .iter()
        .map(|s| s.avg_friendly_item_power - s.avg_enemy_item_power)
        .collect();
    let avg_delta = deltas.iter().sum::<f64>() / deltas.len() as f64;
    if avg_delta > -50.0 {
        return None;
    }
    Some(Finding {
        rule_key: "ip_deficit",
        rule_version: RULE_VERSION,
        severity: if avg_delta <= -100.0 {
            Severity::High
        } else {
            Severity::Medium
        },
        subject_type: "guild",
        subject_id: None,
        period_start,
        period_end,
        metric_value: avg_delta,
        baseline_value: None,
        sample_size: i32::try_from(samples.len()).unwrap_or(i32::MAX),
        evidence: json!({
            "fights": samples.len(),
            "avg_ip_delta": avg_delta,
        }),
    })
}

/// `unpriced_losses`: market-price coverage of our own priced item stacks
/// is below 60%. Minimum sample: **20 item stacks** — a floor this module
/// declares explicitly (plan §7 lists `—`) so a single unpriced loss right
/// after a tenant's first battle doesn't alert (plan §7, rule 13).
pub fn evaluate_unpriced_losses(
    friendly_priced_items: i32,
    friendly_total_items: i32,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_TOTAL_ITEMS: i32 = 20;
    if friendly_total_items < MIN_TOTAL_ITEMS {
        return None;
    }
    let coverage = f64::from(friendly_priced_items) / f64::from(friendly_total_items) * 100.0;
    if coverage >= 60.0 {
        return None;
    }
    Some(Finding {
        rule_key: "unpriced_losses",
        rule_version: RULE_VERSION,
        severity: if coverage < 30.0 {
            Severity::High
        } else {
            Severity::Medium
        },
        subject_type: "guild",
        subject_id: None,
        period_start,
        period_end,
        metric_value: coverage,
        baseline_value: None,
        sample_size: friendly_total_items,
        evidence: json!({
            "friendly_priced_items": friendly_priced_items,
            "friendly_total_items": friendly_total_items,
            "coverage_pct": coverage,
        }),
    })
}

/// `attribution_gap`: fewer than 60% of recent fights are linked to an
/// event. Minimum sample: **10 fights** — a floor this module declares
/// explicitly (plan §7 lists `—`) (plan §7, rule 9). Always `Info`
/// severity: an unattributed fight is a data-completeness gap, not
/// evidence something is going wrong.
#[allow(
    clippy::cast_precision_loss,
    reason = "fights_total/fights_with_event are guild-scale fight counts, orders of magnitude below f64's precision limit"
)]
pub fn evaluate_attribution_gap(
    fights_total: i64,
    fights_with_event: i64,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_SAMPLE: i64 = 10;
    if fights_total < MIN_SAMPLE {
        return None;
    }
    let attributed_pct = fights_with_event as f64 / fights_total as f64 * 100.0;
    if attributed_pct >= 60.0 {
        return None;
    }
    Some(Finding {
        rule_key: "attribution_gap",
        rule_version: RULE_VERSION,
        severity: Severity::Info,
        subject_type: "guild",
        subject_id: None,
        period_start,
        period_end,
        metric_value: attributed_pct,
        baseline_value: None,
        sample_size: i32::try_from(fights_total).unwrap_or(i32::MAX),
        evidence: json!({
            "fights_total": fights_total,
            "fights_with_event": fights_with_event,
            "attributed_pct": attributed_pct,
        }),
    })
}

/// `stale_intel`: an enemy guild we've fought at least 3 distinct battles
/// against hasn't been seen in 30+ days. One finding per qualifying enemy
/// guild — `attention::writer` calls this once per candidate, unlike the
/// other five rules which each produce at most one guild-wide row (plan
/// §7, rule 14).
#[allow(
    clippy::cast_precision_loss,
    reason = "days_stale is a day count in the low thousands at most, orders of magnitude below f64's precision limit"
)]
pub fn evaluate_stale_intel(
    enemy_guild_id: i64,
    last_seen_at: DateTime<Utc>,
    distinct_battles: i64,
    now: DateTime<Utc>,
) -> Option<Finding> {
    const MIN_DISTINCT_BATTLES: i64 = 3;
    const STALE_AFTER_DAYS: i64 = 30;
    if distinct_battles < MIN_DISTINCT_BATTLES {
        return None;
    }
    let days_stale = (now - last_seen_at).num_days();
    if days_stale < STALE_AFTER_DAYS {
        return None;
    }
    Some(Finding {
        rule_key: "stale_intel",
        rule_version: RULE_VERSION,
        severity: Severity::Medium,
        subject_type: "enemy_guild",
        subject_id: Some(enemy_guild_id),
        period_start: last_seen_at,
        period_end: now,
        metric_value: days_stale as f64,
        baseline_value: None,
        sample_size: i32::try_from(distinct_battles).unwrap_or(i32::MAX),
        evidence: json!({
            "enemy_guild_id": enemy_guild_id,
            "distinct_battles": distinct_battles,
            "days_stale": days_stale,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    fn period() -> (DateTime<Utc>, DateTime<Utc>) {
        (now() - Duration::days(30), now())
    }

    // ---- win_rate_drop ----

    #[test]
    fn win_rate_drop_fires_when_drop_exceeds_threshold() {
        let (start, end) = period();
        let current = PeriodOutcomes {
            decided_fights: 20,
            wins: 8, // 40%
        };
        let previous = PeriodOutcomes {
            decided_fights: 20,
            wins: 14, // 70%
        };
        let finding = evaluate_win_rate_drop(current, previous, start, end).expect("should fire");
        assert_eq!(finding.rule_key, "win_rate_drop");
        assert_eq!(finding.severity, Severity::High); // drop = 30 >= 20
        assert!((finding.metric_value - 40.0).abs() < 1e-9);
        assert_eq!(finding.baseline_value, Some(70.0));
        assert_eq!(finding.sample_size, 20);
    }

    #[test]
    fn win_rate_drop_does_not_fire_below_threshold() {
        let (start, end) = period();
        // Only a 5-point drop.
        let current = PeriodOutcomes {
            decided_fights: 20,
            wins: 13,
        };
        let previous = PeriodOutcomes {
            decided_fights: 20,
            wins: 14,
        };
        assert!(evaluate_win_rate_drop(current, previous, start, end).is_none());
    }

    #[test]
    fn win_rate_drop_does_not_fire_below_minimum_sample() {
        let (start, end) = period();
        let current = PeriodOutcomes {
            decided_fights: 5,
            wins: 0,
        };
        let previous = PeriodOutcomes {
            decided_fights: 20,
            wins: 14,
        };
        assert!(evaluate_win_rate_drop(current, previous, start, end).is_none());
    }

    // ---- trade_worsening ----

    #[test]
    fn trade_worsening_fires_when_silver_up_and_fame_flat() {
        let (start, end) = period();
        let current = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 100_000_000, // 10M/fight
            friendly_kill_fame_total: 40_000_000,       // 4M/fight
        };
        let previous = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 76_000_000, // ~7.6M/fight
            friendly_kill_fame_total: 41_000_000,      // ~4.1M/fight, within 10%
        };
        let finding = evaluate_trade_worsening(current, previous, start, end).expect("should fire");
        assert_eq!(finding.rule_key, "trade_worsening");
        assert_eq!(finding.sample_size, 10);
    }

    #[test]
    fn trade_worsening_does_not_fire_when_fame_also_rises() {
        let (start, end) = period();
        let current = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 100_000_000,
            friendly_kill_fame_total: 60_000_000, // +50% fame too
        };
        let previous = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 76_000_000,
            friendly_kill_fame_total: 40_000_000,
        };
        assert!(evaluate_trade_worsening(current, previous, start, end).is_none());
    }

    #[test]
    fn trade_worsening_skips_zero_previous_baseline() {
        let (start, end) = period();
        let current = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 100_000_000,
            friendly_kill_fame_total: 40_000_000,
        };
        let previous = PeriodTrade {
            fights: 10,
            friendly_estimated_loss_total: 0,
            friendly_kill_fame_total: 0,
        };
        assert!(evaluate_trade_worsening(current, previous, start, end).is_none());
    }

    // ---- ip_deficit ----

    #[test]
    fn ip_deficit_fires_on_large_average_gap() {
        let (start, end) = period();
        let samples = vec![
            FightIpSample {
                avg_friendly_item_power: 1300.0,
                avg_enemy_item_power: 1400.0,
            },
            FightIpSample {
                avg_friendly_item_power: 1310.0,
                avg_enemy_item_power: 1420.0,
            },
            FightIpSample {
                avg_friendly_item_power: 1290.0,
                avg_enemy_item_power: 1390.0,
            },
            FightIpSample {
                avg_friendly_item_power: 1305.0,
                avg_enemy_item_power: 1410.0,
            },
            FightIpSample {
                avg_friendly_item_power: 1295.0,
                avg_enemy_item_power: 1405.0,
            },
        ];
        let finding = evaluate_ip_deficit(&samples, start, end).expect("should fire");
        assert_eq!(finding.rule_key, "ip_deficit");
        // deltas: -100, -110, -100, -105, -110 -> avg -105, at/below the -100 High cutoff.
        assert_eq!(finding.severity, Severity::High);
        assert_eq!(finding.sample_size, 5);
    }

    #[test]
    fn ip_deficit_does_not_fire_below_minimum_sample() {
        let (start, end) = period();
        let samples = vec![
            FightIpSample {
                avg_friendly_item_power: 1200.0,
                avg_enemy_item_power: 1400.0,
            };
            4
        ];
        assert!(evaluate_ip_deficit(&samples, start, end).is_none());
    }

    #[test]
    fn ip_deficit_does_not_fire_on_small_gap() {
        let (start, end) = period();
        let samples = vec![
            FightIpSample {
                avg_friendly_item_power: 1390.0,
                avg_enemy_item_power: 1400.0,
            };
            5
        ];
        assert!(evaluate_ip_deficit(&samples, start, end).is_none());
    }

    // ---- unpriced_losses ----

    #[test]
    fn unpriced_losses_fires_below_coverage_threshold() {
        let (start, end) = period();
        let finding =
            evaluate_unpriced_losses(20, 50, start, end).expect("should fire, 40% coverage");
        assert_eq!(finding.rule_key, "unpriced_losses");
        assert!((finding.metric_value - 40.0).abs() < 1e-9);
    }

    #[test]
    fn unpriced_losses_does_not_fire_below_minimum_items() {
        let (start, end) = period();
        // 0/5 = 0% coverage but total_items below the declared floor of 20.
        assert!(evaluate_unpriced_losses(0, 5, start, end).is_none());
    }

    #[test]
    fn unpriced_losses_does_not_fire_above_threshold() {
        let (start, end) = period();
        assert!(evaluate_unpriced_losses(45, 50, start, end).is_none()); // 90%
    }

    // ---- attribution_gap ----

    #[test]
    fn attribution_gap_fires_below_threshold() {
        let (start, end) = period();
        let finding =
            evaluate_attribution_gap(20, 8, start, end).expect("should fire, 40% attributed");
        assert_eq!(finding.rule_key, "attribution_gap");
        assert_eq!(finding.severity, Severity::Info);
    }

    #[test]
    fn attribution_gap_does_not_fire_below_minimum_sample() {
        let (start, end) = period();
        assert!(evaluate_attribution_gap(5, 0, start, end).is_none());
    }

    #[test]
    fn attribution_gap_does_not_fire_above_threshold() {
        let (start, end) = period();
        assert!(evaluate_attribution_gap(20, 15, start, end).is_none()); // 75%
    }

    // ---- stale_intel ----

    #[test]
    fn stale_intel_fires_past_threshold() {
        let now = now();
        let last_seen = now - Duration::days(45);
        let finding = evaluate_stale_intel(7, last_seen, 5, now).expect("should fire");
        assert_eq!(finding.rule_key, "stale_intel");
        assert_eq!(finding.subject_type, "enemy_guild");
        assert_eq!(finding.subject_id, Some(7));
    }

    #[test]
    fn stale_intel_does_not_fire_below_minimum_battles() {
        let now = now();
        let last_seen = now - Duration::days(45);
        assert!(evaluate_stale_intel(7, last_seen, 2, now).is_none());
    }

    #[test]
    fn stale_intel_does_not_fire_when_recently_seen() {
        let now = now();
        let last_seen = now - Duration::days(5);
        assert!(evaluate_stale_intel(7, last_seen, 5, now).is_none());
    }
}
