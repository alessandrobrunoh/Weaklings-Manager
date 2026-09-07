//! The single definition of "did we win".
//!
//! Before this module the same engagement was classified three different ways:
//! the battles list scored our guild alone against a 35%/25% fame split, the
//! canonical Fight resolver demanded unanimity over raw `winner` booleans, and
//! the browser aggregated our whole alliance against 45%/40%/30%. The same
//! battle could therefore read *Victory* on one page and *Contested* on the
//! next, which makes every aggregate built on top of it indefensible.
//!
//! Everything now goes through [`battle_outcome`] and [`combine_segments`].
//!
//! # Why the crown is computed here
//!
//! Upstream sets `winner` rarely, so [`BattleSummary`](crate::modules::battles::models::BattleSummary)
//! crowns the guild that *uniquely* holds the highest kill fame. That crowning
//! used to happen in one conversion path and not the other: `event_battles.is_win`
//! was written from the raw `AlbionBB` payload while `guilds_json` stored the
//! crowned copy. Feeding both into one resolver produced "conflicting evidence"
//! and an [`Unknown`](BattleOutcome::Unknown) outcome for fights that were
//! perfectly decided.
//!
//! This module therefore crowns the lines it is given, every time. Callers can
//! pass raw upstream guilds or already-converted summaries and get the same
//! answer.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Fame share at or above which our side is treated as the fame leader.
pub const FAME_LEAD_SHARE: f64 = 0.45;
/// Fame share required to turn a positive kill trade into a victory.
pub const FAME_ADVANTAGE_SHARE: f64 = 0.40;
/// Fame share below which a negative kill trade becomes a defeat.
pub const FAME_DEFICIT_SHARE: f64 = 0.30;

/// An engagement's outcome from our side's perspective.
///
/// `Unknown` is a real answer, not a placeholder: it means the evidence does
/// not identify our side at all, and it must never be displayed or aggregated
/// as a loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BattleOutcome {
    Victory,
    Defeat,
    Draw,
    Unknown,
}

impl BattleOutcome {
    /// Stable string form, matching the serialized representation.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Victory => "victory",
            Self::Defeat => "defeat",
            Self::Draw => "draw",
            Self::Unknown => "unknown",
        }
    }

    /// Parses a filter value from a query string.
    ///
    /// `contested` is accepted as a synonym of `draw` so links and bookmarks
    /// created against the previous vocabulary keep working.
    #[must_use]
    pub fn from_query(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "victory" => Some(Self::Victory),
            "defeat" => Some(Self::Defeat),
            "draw" | "contested" => Some(Self::Draw),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

/// Which guilds count as ours.
///
/// IDs stay case-sensitive because Albion IDs are opaque; names are lower-cased
/// because they come from operator-typed configuration.
#[derive(Debug, Clone, Default)]
pub struct FriendlySide {
    guild_id: String,
    allied_ids: HashSet<String>,
    allied_names: HashSet<String>,
}

impl FriendlySide {
    /// Builds the classifier from a guild ID plus allied ID and name lists.
    #[must_use]
    pub fn new(guild_id: &str, allied_ids: &[String], allied_names: &[String]) -> Self {
        Self {
            guild_id: guild_id.to_string(),
            allied_ids: allied_ids.iter().cloned().collect(),
            allied_names: allied_names
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect(),
        }
    }

    /// Returns `true` when a battle guild fights on our side.
    #[must_use]
    pub fn contains(&self, guild_id: &str, guild_name: &str) -> bool {
        if !guild_id.is_empty() && (guild_id == self.guild_id || self.allied_ids.contains(guild_id))
        {
            return true;
        }
        if guild_name.trim().is_empty() {
            return false;
        }
        self.allied_names.contains(&guild_name.to_ascii_lowercase())
    }
}

/// One guild's line in a battle, in the minimal shape the rule needs.
///
/// Borrowed so both the upstream payload and the persisted summary can be
/// classified without cloning either.
#[derive(Debug, Clone, Copy)]
pub struct GuildLine<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    /// The upstream winner flag, before this module applies its own crowning.
    pub winner: bool,
}

/// Our side's combined totals for one battle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SideRollup {
    /// Whether any guild in the battle was recognised as ours.
    pub resolved: bool,
    /// How many of our guilds took part.
    pub guilds: i64,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    /// Upstream winner flag, or sole holder of the highest kill fame.
    pub crowned_winner: bool,
}

/// An outcome plus the reason it was reached.
#[derive(Debug, Clone, PartialEq)]
pub struct OutcomeVerdict {
    pub outcome: BattleOutcome,
    /// Stable identifier for the branch that decided this verdict.
    pub method: &'static str,
    /// Our share of the battle's total fame, `0.0` when there is no fame.
    pub fame_share: f64,
}

/// Aggregates our side and applies the crowning rule.
///
/// A guild is crowned when upstream says so, or when it is the *sole* holder of
/// a non-zero maximum kill fame. A tie for the top spot crowns nobody, because
/// a tie is exactly the case where the fame lead proves nothing.
#[must_use]
pub fn roll_up(guilds: &[GuildLine<'_>], side: &FriendlySide) -> SideRollup {
    let max_kill_fame = guilds
        .iter()
        .map(|guild| guild.kill_fame)
        .max()
        .unwrap_or(0);
    let sole_leader = max_kill_fame > 0
        && guilds
            .iter()
            .filter(|guild| guild.kill_fame == max_kill_fame)
            .count()
            == 1;

    let mut rollup = SideRollup::default();
    for guild in guilds {
        if !side.contains(guild.id, guild.name) {
            continue;
        }
        rollup.resolved = true;
        rollup.guilds += 1;
        rollup.kills += guild.kills;
        rollup.deaths += guild.deaths;
        rollup.kill_fame += guild.kill_fame;
        if guild.winner || (sole_leader && guild.kill_fame == max_kill_fame) {
            rollup.crowned_winner = true;
        }
    }
    rollup
}

/// Classifies a rolled-up side against the battle's total fame.
#[must_use]
pub fn classify(rollup: &SideRollup, total_fame: i64) -> OutcomeVerdict {
    if !rollup.resolved {
        return OutcomeVerdict {
            outcome: BattleOutcome::Unknown,
            method: "our_side_not_resolved",
            fame_share: 0.0,
        };
    }
    if total_fame <= 0 {
        return OutcomeVerdict {
            outcome: BattleOutcome::Unknown,
            method: "no_fame_evidence",
            fame_share: 0.0,
        };
    }

    let fame_share = rollup.kill_fame as f64 / total_fame as f64;
    let (outcome, method) = if rollup.crowned_winner || fame_share >= FAME_LEAD_SHARE {
        (BattleOutcome::Victory, "fame_lead")
    } else if rollup.kills > rollup.deaths && fame_share >= FAME_ADVANTAGE_SHARE {
        (BattleOutcome::Victory, "kill_and_fame_advantage")
    } else if rollup.deaths > rollup.kills && fame_share < FAME_DEFICIT_SHARE {
        (BattleOutcome::Defeat, "kill_and_fame_deficit")
    } else {
        (BattleOutcome::Draw, "contested")
    };

    OutcomeVerdict {
        outcome,
        method,
        fame_share,
    }
}

/// The whole rule for one battle: crown, roll up our side, classify.
#[must_use]
pub fn battle_outcome(
    guilds: &[GuildLine<'_>],
    total_fame: i64,
    side: &FriendlySide,
) -> OutcomeVerdict {
    classify(&roll_up(guilds, side), total_fame)
}

/// A canonical Fight's outcome, aggregated over its battle segments.
#[derive(Debug, Clone, PartialEq)]
pub struct FightVerdict {
    pub outcome: BattleOutcome,
    pub method: String,
    /// Segments the fight contains.
    pub segments: i64,
    /// Segments that produced a decided outcome.
    pub segments_resolved: i64,
}

/// Combines per-segment verdicts into one Fight outcome.
///
/// Undecidable segments are skipped rather than poisoning the whole fight:
/// a three-segment engagement where one segment has not been hydrated yet is
/// still decided by the two that have, and `segments_resolved` discloses that
/// the verdict rests on partial coverage. The previous resolver returned
/// `Unknown` for the entire fight in that case.
#[must_use]
pub fn combine_segments(verdicts: &[OutcomeVerdict]) -> FightVerdict {
    let segments = i64::try_from(verdicts.len()).unwrap_or(i64::MAX);
    if verdicts.is_empty() {
        return FightVerdict {
            outcome: BattleOutcome::Unknown,
            method: "no_segments".to_string(),
            segments: 0,
            segments_resolved: 0,
        };
    }

    let decided: Vec<BattleOutcome> = verdicts
        .iter()
        .map(|verdict| verdict.outcome)
        .filter(|outcome| *outcome != BattleOutcome::Unknown)
        .collect();
    let segments_resolved = i64::try_from(decided.len()).unwrap_or(i64::MAX);
    if decided.is_empty() {
        return FightVerdict {
            outcome: BattleOutcome::Unknown,
            method: "no_resolved_segments".to_string(),
            segments,
            segments_resolved: 0,
        };
    }

    let (outcome, base_method) = if decided
        .iter()
        .all(|outcome| *outcome == BattleOutcome::Victory)
    {
        (BattleOutcome::Victory, "unanimous_segments")
    } else if decided
        .iter()
        .all(|outcome| *outcome == BattleOutcome::Defeat)
    {
        (BattleOutcome::Defeat, "unanimous_segments")
    } else {
        (BattleOutcome::Draw, "mixed_segments")
    };

    let method = if segments_resolved < segments {
        format!("{base_method}_partial_coverage")
    } else {
        base_method.to_string()
    };

    FightVerdict {
        outcome,
        method,
        segments,
        segments_resolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side() -> FriendlySide {
        FriendlySide::new(
            "us",
            &["ally-id".to_string()],
            &["BetterGetBack".to_string()],
        )
    }

    fn line<'a>(
        id: &'a str,
        name: &'a str,
        kills: i64,
        deaths: i64,
        kill_fame: i64,
    ) -> GuildLine<'a> {
        GuildLine {
            id,
            name,
            kills,
            deaths,
            kill_fame,
            winner: false,
        }
    }

    #[test]
    fn contested_synonym_parses_as_draw() {
        assert_eq!(
            BattleOutcome::from_query("contested"),
            Some(BattleOutcome::Draw)
        );
        assert_eq!(
            BattleOutcome::from_query(" DRAW "),
            Some(BattleOutcome::Draw)
        );
        assert_eq!(BattleOutcome::from_query("nonsense"), None);
    }

    #[test]
    fn side_matches_by_id_then_allied_id_then_name() {
        let side = side();
        assert!(side.contains("us", "Weaklings"));
        assert!(side.contains("ally-id", "Whoever"));
        assert!(side.contains("", "bettergetback"));
        assert!(!side.contains("them", "ARCH"));
    }

    /// An empty ID must not match a friendly side whose configured ID is also
    /// empty, otherwise every unidentified guild becomes ours.
    #[test]
    fn empty_id_never_matches_by_id() {
        let side = FriendlySide::new("", &[], &["us".to_string()]);
        assert!(!side.contains("", "ARCH"));
        assert!(side.contains("", "us"));
    }

    #[test]
    fn our_side_not_in_the_battle_is_unknown_not_a_loss() {
        let guilds = [line("them", "ARCH", 10, 2, 900_000)];
        let verdict = battle_outcome(&guilds, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Unknown);
        assert_eq!(verdict.method, "our_side_not_resolved");
    }

    #[test]
    fn a_battle_without_fame_is_unknown() {
        let guilds = [line("us", "Weaklings", 0, 0, 0)];
        let verdict = battle_outcome(&guilds, 0, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Unknown);
        assert_eq!(verdict.method, "no_fame_evidence");
    }

    #[test]
    fn sole_holder_of_the_top_fame_is_crowned_and_wins() {
        let guilds = [
            line("us", "Weaklings", 4, 6, 600_000),
            line("them", "ARCH", 6, 4, 400_000),
        ];
        let verdict = battle_outcome(&guilds, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Victory);
        assert_eq!(verdict.method, "fame_lead");
    }

    /// A tie for the highest fame proves nothing, so nobody is crowned and the
    /// kill trade decides instead.
    #[test]
    fn a_tie_for_top_fame_crowns_nobody() {
        let guilds = [
            line("us", "Weaklings", 2, 8, 500_000),
            line("them", "ARCH", 8, 2, 500_000),
        ];
        let rollup = roll_up(&guilds, &side());
        assert!(!rollup.crowned_winner);
        assert_eq!(
            classify(&rollup, 1_000_000).outcome,
            // 50% fame share still clears the lead threshold on its own.
            BattleOutcome::Victory
        );
    }

    #[test]
    fn upstream_winner_flag_is_honoured_even_without_the_fame_lead() {
        let guilds = [
            GuildLine {
                winner: true,
                ..line("us", "Weaklings", 1, 9, 50_000)
            },
            line("them", "ARCH", 9, 1, 950_000),
        ];
        let verdict = battle_outcome(&guilds, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Victory);
    }

    /// Crowning is applied by this module, so a caller passing the raw upstream
    /// payload and a caller passing an already-crowned summary must agree.
    #[test]
    fn crowning_is_idempotent_across_input_shapes() {
        let raw = [
            line("us", "Weaklings", 4, 6, 600_000),
            line("them", "ARCH", 6, 4, 400_000),
        ];
        let pre_crowned = [
            GuildLine {
                winner: true,
                ..line("us", "Weaklings", 4, 6, 600_000)
            },
            line("them", "ARCH", 6, 4, 400_000),
        ];
        assert_eq!(
            battle_outcome(&raw, 1_000_000, &side()).outcome,
            battle_outcome(&pre_crowned, 1_000_000, &side()).outcome
        );
    }

    #[test]
    fn positive_trade_with_enough_fame_is_a_victory() {
        let guilds = [
            line("us", "Weaklings", 7, 3, 420_000),
            line("a", "ARCH", 3, 7, 430_000),
            line("b", "POE", 2, 2, 150_000),
        ];
        let verdict = battle_outcome(&guilds, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Victory);
        assert_eq!(verdict.method, "kill_and_fame_advantage");
    }

    #[test]
    fn negative_trade_with_little_fame_is_a_defeat() {
        let guilds = [
            line("us", "Weaklings", 2, 9, 200_000),
            line("a", "ARCH", 9, 2, 500_000),
            line("b", "POE", 3, 3, 300_000),
        ];
        let verdict = battle_outcome(&guilds, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Defeat);
        assert_eq!(verdict.method, "kill_and_fame_deficit");
    }

    /// Exactly on a threshold the more favourable branch wins, and one fame
    /// point below it does not.
    #[test]
    fn thresholds_are_inclusive_on_the_favourable_side() {
        let at_advantage = [
            line("us", "Weaklings", 5, 4, 400_000),
            line("a", "ARCH", 4, 5, 410_000),
            line("b", "POE", 1, 1, 190_000),
        ];
        assert_eq!(
            battle_outcome(&at_advantage, 1_000_000, &side()).outcome,
            BattleOutcome::Victory
        );

        let just_below = [
            line("us", "Weaklings", 5, 4, 399_999),
            line("a", "ARCH", 4, 5, 410_000),
            line("b", "POE", 1, 1, 190_001),
        ];
        assert_eq!(
            battle_outcome(&just_below, 1_000_000, &side()).outcome,
            BattleOutcome::Draw
        );

        let at_deficit = [
            line("us", "Weaklings", 2, 9, 300_000),
            line("a", "ARCH", 9, 2, 500_000),
            line("b", "POE", 1, 1, 200_000),
        ];
        assert_eq!(
            battle_outcome(&at_deficit, 1_000_000, &side()).outcome,
            BattleOutcome::Draw,
            "exactly at the deficit threshold is not yet a defeat"
        );
    }

    #[test]
    fn allied_guilds_are_counted_on_our_side() {
        let solo = [
            line("us", "Weaklings", 2, 3, 200_000),
            line("a", "ARCH", 8, 7, 800_000),
        ];
        assert_eq!(
            battle_outcome(&solo, 1_000_000, &side()).outcome,
            BattleOutcome::Defeat
        );

        let with_ally = [
            line("us", "Weaklings", 2, 3, 200_000),
            line("ally-id", "Friends", 6, 4, 400_000),
            line("a", "ARCH", 8, 7, 400_000),
        ];
        let verdict = battle_outcome(&with_ally, 1_000_000, &side());
        assert_eq!(verdict.outcome, BattleOutcome::Victory);
        assert_eq!(verdict.method, "fame_lead");
    }

    fn verdict(outcome: BattleOutcome) -> OutcomeVerdict {
        OutcomeVerdict {
            outcome,
            method: "test",
            fame_share: 0.5,
        }
    }

    #[test]
    fn a_fight_with_no_segments_is_unknown() {
        let combined = combine_segments(&[]);
        assert_eq!(combined.outcome, BattleOutcome::Unknown);
        assert_eq!(combined.method, "no_segments");
    }

    #[test]
    fn unanimous_segments_decide_the_fight() {
        let combined = combine_segments(&[
            verdict(BattleOutcome::Victory),
            verdict(BattleOutcome::Victory),
        ]);
        assert_eq!(combined.outcome, BattleOutcome::Victory);
        assert_eq!(combined.method, "unanimous_segments");
        assert_eq!(combined.segments_resolved, 2);
    }

    #[test]
    fn mixed_segments_are_a_draw() {
        let combined = combine_segments(&[
            verdict(BattleOutcome::Victory),
            verdict(BattleOutcome::Defeat),
        ]);
        assert_eq!(combined.outcome, BattleOutcome::Draw);
        assert_eq!(combined.method, "mixed_segments");
    }

    /// The regression this module exists for: one unhydrated segment used to
    /// turn a decided fight into `Unknown`.
    #[test]
    fn an_undecidable_segment_does_not_poison_the_fight() {
        let combined = combine_segments(&[
            verdict(BattleOutcome::Victory),
            verdict(BattleOutcome::Unknown),
            verdict(BattleOutcome::Victory),
        ]);
        assert_eq!(combined.outcome, BattleOutcome::Victory);
        assert_eq!(combined.method, "unanimous_segments_partial_coverage");
        assert_eq!(combined.segments, 3);
        assert_eq!(combined.segments_resolved, 2);
    }

    #[test]
    fn a_fight_where_nothing_resolves_stays_unknown() {
        let combined = combine_segments(&[
            verdict(BattleOutcome::Unknown),
            verdict(BattleOutcome::Unknown),
        ]);
        assert_eq!(combined.outcome, BattleOutcome::Unknown);
        assert_eq!(combined.method, "no_resolved_segments");
        assert_eq!(combined.segments_resolved, 0);
    }
}
