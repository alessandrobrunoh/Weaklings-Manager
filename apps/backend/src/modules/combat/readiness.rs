//! Comp-level readiness: can this composition actually be fielded tonight?
//!
//! Pure over [`fit::Seat`]/[`fit::Member`] — no database — so the roll-up is unit-testable on its
//! own. The service layer turns a comp's `comp_builds` (via
//! [`crate::modules::events::service::EventService::canonical_roster_seats`]) and a candidate pool
//! of members with any recorded specialization into these shapes.

use serde::Serialize;
use utoipa::ToSchema;

use super::fit::{self, Member, Seat};
use super::ip::{self, SpecLevels};

/// A member is "qualified" for a seat once they reach this fraction of its Item Power ceiling.
///
/// 0.8 rather than 1.0: full readiness (every relevant node at 100, see
/// [`SpecLevels::all_at`]'s docs) is an extreme most active members never reach, so a floor set
/// there would make every comp look permanently unfielded. 80% is close enough to "geared for it"
/// to be a useful signal without demanding the literal maximum.
pub const QUALIFIED_READINESS_FLOOR: f64 = 0.8;

/// How many of a comp's weakest seats to report in detail.
const MAX_WEAKEST_SEATS: usize = 10;

/// One seat's best available candidate, or the absence of one.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SeatReadiness {
    /// The seat key, e.g. `build:12:3`.
    pub seat_key: String,
    /// The build this seat requires.
    pub build_id: i64,
    /// The build's name.
    pub build_name: String,
    /// The best-scoring member for this seat, or `None` when nobody in the pool has any relevant
    /// specialization at all.
    pub best_candidate_user_id: Option<i64>,
    /// That member's Item Power on this seat.
    pub best_candidate_item_power: f64,
    /// This seat's Item Power ceiling — every relevant node at 100.
    pub max_item_power: f64,
    /// `best_candidate_item_power / max_item_power`, `0.0` when nobody is available.
    pub readiness: f64,
    /// `max_item_power - best_candidate_item_power`: the Item Power a training push could still
    /// recover for this seat.
    pub item_power_gap: f64,
    /// How many members in the pool clear [`QUALIFIED_READINESS_FLOOR`] for this seat.
    pub qualified_members: usize,
}

/// How deep the bench is for one build across every seat it fills.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BuildCoverage {
    /// The build in question.
    pub build_id: i64,
    /// Its name.
    pub build_name: String,
    /// How many distinct seats in the comp need this build.
    pub seat_count: usize,
    /// How many members in the pool clear [`QUALIFIED_READINESS_FLOOR`] for it — the number that
    /// answers "can we actually field this many tonight".
    pub qualified_members: usize,
}

/// The full readiness roll-up for a composition.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CompReadiness {
    /// Seats the comp defines.
    pub seat_count: usize,
    /// Mean of each seat's best available candidate's Item Power. `0.0` when the pool is empty.
    pub avg_item_power_now: f64,
    /// Mean of each seat's Item Power ceiling.
    pub avg_item_power_at_max: f64,
    /// `avg_item_power_now / avg_item_power_at_max`, clamped `0.0` through `1.0`.
    pub readiness_pct: f64,
    /// The seats furthest from their ceiling, worst first, capped at
    /// [`MAX_WEAKEST_SEATS`].
    pub weakest_seats: Vec<SeatReadiness>,
    /// One row per distinct build the comp uses.
    pub bench_coverage: Vec<BuildCoverage>,
    /// Seats with zero qualified candidates — the training priorities.
    pub uncovered_seats: Vec<String>,
    /// False when nobody in the pool has a recorded family mastery level, which makes every
    /// Item Power figure here a lower bound.
    pub mastery_levels_known: bool,
}

/// Scores every seat against every member and rolls the result up to comp level.
///
/// An empty `members` pool is not an error: every seat comes back with no candidate, which is
/// exactly the "nobody can fly this yet" state a fresh comp is in.
#[must_use]
// A comp has at most a few hundred seats; the usize-to-f64 cast below cannot lose precision at
// that scale.
#[allow(clippy::cast_precision_loss)]
pub fn evaluate(seats: &[Seat], members: &[Member]) -> CompReadiness {
    let mut seat_readiness: Vec<SeatReadiness> = seats
        .iter()
        .map(|seat| evaluate_seat(seat, members))
        .collect();

    let seat_count = seats.len();
    let avg = |pick: fn(&SeatReadiness) -> f64| -> f64 {
        if seat_count == 0 {
            return 0.0;
        }
        seat_readiness.iter().map(pick).sum::<f64>() / seat_count as f64
    };
    let avg_item_power_now = avg(|seat| seat.best_candidate_item_power);
    let avg_item_power_at_max = avg(|seat| seat.max_item_power);

    let uncovered_seats: Vec<String> = seat_readiness
        .iter()
        .filter(|seat| seat.qualified_members == 0)
        .map(|seat| seat.seat_key.clone())
        .collect();

    seat_readiness.sort_by(|a, b| {
        a.readiness
            .partial_cmp(&b.readiness)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.seat_key.cmp(&b.seat_key))
    });
    seat_readiness.truncate(MAX_WEAKEST_SEATS);

    CompReadiness {
        seat_count,
        avg_item_power_now,
        avg_item_power_at_max,
        readiness_pct: if avg_item_power_at_max > 0.0 {
            (avg_item_power_now / avg_item_power_at_max).clamp(0.0, 1.0)
        } else {
            0.0
        },
        weakest_seats: seat_readiness,
        bench_coverage: build_coverage(seats, members),
        uncovered_seats,
        mastery_levels_known: members.iter().any(|member| member.specs.mastery_levels_known()),
    }
}

/// Scores one seat against every member, keeping the best.
fn evaluate_seat(seat: &Seat, members: &[Member]) -> SeatReadiness {
    let max_item_power = ip::character_ip(&seat.items, &SpecLevels::all_at(100)).average;
    let qualified_members = members
        .iter()
        .filter(|member| fit::score(member, seat).readiness >= QUALIFIED_READINESS_FLOOR)
        .count();

    let best = members
        .iter()
        .map(|member| (member.user_id, fit::score(member, seat)))
        .max_by(|(_, a), (_, b)| {
            a.item_power.partial_cmp(&b.item_power).unwrap_or(std::cmp::Ordering::Equal)
        });

    let (best_candidate_user_id, best_candidate_item_power, readiness) = match best {
        Some((user_id, score)) => (Some(user_id), score.item_power, score.readiness),
        None => (None, 0.0, 0.0),
    };

    SeatReadiness {
        seat_key: seat.seat_key.clone(),
        build_id: seat.build_id,
        build_name: String::new(), // filled in by the caller, which knows build names
        best_candidate_user_id,
        best_candidate_item_power,
        max_item_power,
        readiness,
        item_power_gap: (max_item_power - best_candidate_item_power).max(0.0),
        qualified_members,
    }
}

/// One row per distinct build, counting members who qualify for it on any of its seats.
///
/// A member counts once per build no matter how many of its seats they qualify for — every seat of
/// the same build shares one loadout, so their score would be identical on each.
fn build_coverage(seats: &[Seat], members: &[Member]) -> Vec<BuildCoverage> {
    let mut coverage: Vec<BuildCoverage> = Vec::new();
    for seat in seats {
        if let Some(existing) = coverage.iter_mut().find(|entry| entry.build_id == seat.build_id) {
            existing.seat_count += 1;
            continue;
        }
        let qualified_members = members
            .iter()
            .filter(|member| fit::score(member, seat).readiness >= QUALIFIED_READINESS_FLOOR)
            .count();
        coverage.push(BuildCoverage {
            build_id: seat.build_id,
            build_name: String::new(), // filled in by the caller
            seat_count: 1,
            qualified_members,
        });
    }
    coverage
}

#[cfg(test)]
mod readiness_tests {
    use super::{QUALIFIED_READINESS_FLOOR, evaluate};
    use crate::modules::combat::fit::{Member, Seat};
    use crate::modules::combat::ip::{EquippedItem, SpecLevels};
    use crate::modules::comps::status::BuildSlot;

    fn seat(seat_key: &str, build_id: i64, base: &str) -> Seat {
        Seat {
            seat_key: seat_key.to_string(),
            build_id,
            items: vec![EquippedItem {
                slot: BuildSlot::Weapon,
                base: base.to_string(),
                tier: 8,
                enchantment: 0,
                quality: 1,
            }],
        }
    }

    fn member(user_id: i64, specs: &[(&str, i32)]) -> Member {
        Member {
            user_id,
            specs: SpecLevels::from_rows(specs.iter().map(|(k, l)| (*k, *l))),
            primary_build_id: None,
            secondary_build_id: None,
        }
    }

    #[test]
    fn an_empty_pool_leaves_every_seat_uncovered() {
        let seats = [seat("build:1:1", 1, "2H_POLEHAMMER")];
        let readiness = evaluate(&seats, &[]);
        assert_eq!(readiness.seat_count, 1);
        assert_eq!(readiness.uncovered_seats, vec!["build:1:1".to_string()]);
        assert!((readiness.avg_item_power_now - 0.0).abs() < f64::EPSILON);
        assert_eq!(readiness.weakest_seats[0].best_candidate_user_id, None);
    }

    #[test]
    fn a_well_trained_member_covers_their_seat() {
        let seats = [seat("build:1:1", 1, "2H_POLEHAMMER")];
        let members = [member(1, &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)])];
        let readiness = evaluate(&seats, &members);
        assert!(readiness.uncovered_seats.is_empty());
        assert_eq!(readiness.weakest_seats[0].best_candidate_user_id, Some(1));
        assert_eq!(readiness.weakest_seats[0].qualified_members, 1);
        assert!(readiness.readiness_pct > QUALIFIED_READINESS_FLOOR);
    }

    #[test]
    fn the_best_of_several_candidates_is_kept() {
        let seats = [seat("build:1:1", 1, "2H_POLEHAMMER")];
        let members = [
            member(1, &[("weapon:2H_POLEHAMMER", 20)]),
            member(2, &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)]),
        ];
        let readiness = evaluate(&seats, &members);
        assert_eq!(readiness.weakest_seats[0].best_candidate_user_id, Some(2));
    }

    #[test]
    fn weakest_seats_are_sorted_worst_first() {
        let seats = [
            seat("build:1:1", 1, "2H_POLEHAMMER"),
            seat("build:2:1", 2, "MAIN_ARCANESTAFF"),
        ];
        let members = [member(1, &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)])];
        let readiness = evaluate(&seats, &members);
        // The astral seat has no candidate at all, so it is strictly worse than the hammer seat.
        assert_eq!(readiness.weakest_seats[0].seat_key, "build:2:1");
        assert_eq!(readiness.weakest_seats[1].seat_key, "build:1:1");
    }

    #[test]
    fn bench_coverage_groups_seats_of_the_same_build_and_counts_each_member_once() {
        let seats =
            [seat("build:1:1", 1, "2H_POLEHAMMER"), seat("build:1:2", 1, "2H_POLEHAMMER")];
        let members = [member(1, &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)])];
        let readiness = evaluate(&seats, &members);
        assert_eq!(readiness.bench_coverage.len(), 1, "one build, not one row per seat");
        assert_eq!(readiness.bench_coverage[0].seat_count, 2);
        assert_eq!(readiness.bench_coverage[0].qualified_members, 1);
    }

    #[test]
    fn mastery_levels_known_reflects_the_whole_pool() {
        let seats = [seat("build:1:1", 1, "2H_POLEHAMMER")];
        let without_mastery = [member(1, &[("weapon:2H_POLEHAMMER", 100)])];
        let with_mastery = [member(1, &[("mastery:COMBAT_HAMMERS", 50)])];
        assert!(!evaluate(&seats, &without_mastery).mastery_levels_known);
        assert!(evaluate(&seats, &with_mastery).mastery_levels_known);
    }

    #[test]
    fn readiness_pct_is_zero_when_the_comp_has_no_seats() {
        let readiness = evaluate(&[], &[member(1, &[])]);
        assert_eq!(readiness.seat_count, 0);
        assert!((readiness.readiness_pct - 0.0).abs() < f64::EPSILON);
        assert!(readiness.weakest_seats.is_empty());
        assert!(readiness.uncovered_seats.is_empty());
    }
}
