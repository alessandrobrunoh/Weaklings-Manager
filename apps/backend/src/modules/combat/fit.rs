//! Which member fits which seat, and the optimal assignment across a whole roster.
//!
//! Pure over plain structs — no database, no async — so the scoring and the assignment algorithm
//! are each unit-testable on their own. The service layer above this turns `event_participations`,
//! `canonical_roster_seats` and `user_specializations` into [`Member`] and [`Seat`]; nothing here
//! knows those tables exist.
//!
//! # Why Hungarian, not greedy
//!
//! `auto_fill_roster` today is first-fit: it walks participants in signup order and gives each the
//! first seat matching their preferred build. That is provably wrong the moment two members are
//! both the only viable pilot for two different seats — the one who signed up first eats a seat the
//! other member also fits, and the seat that actually needed the second member's specialization
//! goes unfilled or falls back to someone worse.
//!
//! [`assign`] instead solves the whole matrix at once with the Kuhn–Munkres (Hungarian) algorithm,
//! O(n³) on a square matrix padded with zero-cost dummies. A guild roster is bounded by
//! `events.player_cap` and the seat-numbering scheme (`party = index / 20 + 1`) to realistically at
//! most a couple hundred seats, so a few hundred thousand operations costs microseconds — there is
//! no scale at which the naive approach would be justified by speed.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ip::{self, CharacterIpBreakdown, EquippedItem, SpecLevels};

/// Which build a member already asked to fly, if any — a signal to prefer, not a constraint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Preference {
    /// No signup preference recorded.
    #[default]
    None,
    /// This build is the member's stated secondary choice.
    Secondary,
    /// This build is the member's stated primary choice.
    Primary,
}

impl Preference {
    /// Additive Item Power bonus a preference contributes to a score.
    ///
    /// Calibrated to matter without dominating: 50 Item Power is roughly what one mid Destiny
    /// Board level of a single node is worth, enough to break a near-tie in the preferred
    /// direction without overriding a member who is dramatically better trained for a seat they
    /// did not ask for.
    const fn bonus(self) -> f64 {
        match self {
            Self::None => 0.0,
            Self::Secondary => 25.0,
            Self::Primary => 50.0,
        }
    }
}

/// One member available to be seated.
#[derive(Debug, Clone)]
pub struct Member {
    /// Internal user id.
    pub user_id: i64,
    /// Destiny Board levels.
    pub specs: SpecLevels,
    /// The build they signed up as primary, if any.
    pub primary_build_id: Option<i64>,
    /// The build they signed up as secondary, if any.
    pub secondary_build_id: Option<i64>,
}

/// One seat to be filled.
#[derive(Debug, Clone)]
// `seat_key` matches the name used throughout `events::models` (`EventRosterAssignment.seat_key`,
// `EventRosterSeatView.key`'s counterpart); renaming it here for this lint would make the two
// modules harder to cross-reference, not easier to read.
#[allow(clippy::struct_field_names)]
pub struct Seat {
    /// The seat key, e.g. `build:12:3`.
    pub seat_key: String,
    /// The build this seat requires.
    pub build_id: i64,
    /// The build's own loadout, already resolved to items.
    pub items: Vec<EquippedItem>,
}

/// How well one member fits one seat.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FitScore {
    /// Item Power the member would bring to this seat's build.
    pub item_power: f64,
    /// The same build's Item Power with every node at 100 — the shared ceiling.
    pub max_item_power: f64,
    /// `item_power / max_item_power`, `0.0` through `1.0`. Comparable across different builds in a
    /// way raw Item Power is not.
    pub readiness: f64,
    /// The member's signup preference for this seat's build.
    pub preference: Preference,
    /// Reasons this pairing cannot be made, empty when it can.
    pub blocking: Vec<String>,
}

impl FitScore {
    /// The number the assignment algorithm actually optimises: readiness, nudged by preference.
    ///
    /// Readiness rather than raw Item Power, so a healer seat is not structurally worth less than
    /// a tank seat to the solver. Preference enters as Item-Power-scaled points converted to the
    /// same 0..1 readiness units via the seat's own ceiling, so its weight does not depend on how
    /// high that ceiling happens to be.
    #[must_use]
    pub fn combined(&self) -> f64 {
        if !self.blocking.is_empty() || self.max_item_power <= 0.0 {
            return 0.0;
        }
        self.readiness + self.preference.bonus() / self.max_item_power
    }
}

/// Scores one member against one seat.
///
/// Never fails: a seat with no data behind it, or a member with no relevant specialization, comes
/// back as a real (low) score rather than an error, because "this pairing is bad" and "this
/// pairing is impossible" are different facts the caller needs told apart.
#[must_use]
pub fn score(member: &Member, seat: &Seat) -> FitScore {
    let breakdown: CharacterIpBreakdown = ip::character_ip(&seat.items, &member.specs);
    let ceiling = ip::character_ip(&seat.items, &SpecLevels::all_at(100)).average;
    let preference = if Some(seat.build_id) == member.primary_build_id {
        Preference::Primary
    } else if Some(seat.build_id) == member.secondary_build_id {
        Preference::Secondary
    } else {
        Preference::None
    };

    let mut blocking = Vec::new();
    if seat.items.is_empty() {
        blocking.push("seat has no equipped items to score against".to_string());
    }

    FitScore {
        item_power: breakdown.average,
        max_item_power: ceiling,
        readiness: if ceiling > 0.0 { (breakdown.average / ceiling).clamp(0.0, 1.0) } else { 0.0 },
        preference,
        blocking,
    }
}

/// Which algorithm produced an assignment, so a caller can tell a considered plan from the
/// existing first-fit behaviour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FitStrategy {
    /// First matching seat in signup order — today's `auto_fill_roster` behaviour, unchanged.
    #[default]
    Greedy,
    /// Optimal assignment maximising the sum of [`FitScore::combined`] over the whole roster.
    SpecOptimal,
}

/// One placement the solver chose.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Placement {
    /// The seat filled.
    pub seat_key: String,
    /// The member placed there.
    pub user_id: i64,
    /// How well they fit it.
    pub score: FitScore,
}

/// The result of solving a roster: who goes where, and who and what is left over.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Assignment {
    /// Every seat that was filled.
    pub placements: Vec<Placement>,
    /// Members the solver could not place — more members than fillable seats, or every remaining
    /// pairing was blocked.
    pub unplaced_members: Vec<i64>,
    /// Seats nothing could be placed into.
    pub unfilled_seats: Vec<String>,
}

/// Solves the whole roster at once: which member goes in which seat to maximise total fit.
///
/// Deterministic — ties are broken on `(user_id, seat_key)` — because the roster is shared over a
/// websocket and two runs over the same input reordered must agree, or officers watching live would
/// see the assignment flicker between equally-scored alternatives.
#[must_use]
pub fn assign(members: &[Member], seats: &[Seat]) -> Assignment {
    if members.is_empty() || seats.is_empty() {
        return Assignment {
            placements: Vec::new(),
            unplaced_members: members.iter().map(|member| member.user_id).collect(),
            unfilled_seats: seats.iter().map(|seat| seat.seat_key.clone()).collect(),
        };
    }

    let scores: Vec<Vec<FitScore>> =
        members.iter().map(|member| seats.iter().map(|seat| score(member, seat)).collect()).collect();

    let assignment = hungarian::solve(&scores.iter().map(|row| row.iter().map(FitScore::combined).collect()).collect::<Vec<Vec<f64>>>());

    let mut placements = Vec::new();
    let mut placed_members = vec![false; members.len()];
    let mut filled_seats = vec![false; seats.len()];

    for (member_index, seat_index) in assignment.into_iter().enumerate() {
        let Some(seat_index) = seat_index else { continue };
        let fit = &scores[member_index][seat_index];
        if !fit.blocking.is_empty() {
            continue; // The solver may still pair a blocked cell when nothing better is left.
        }
        placed_members[member_index] = true;
        filled_seats[seat_index] = true;
        placements.push(Placement {
            seat_key: seats[seat_index].seat_key.clone(),
            user_id: members[member_index].user_id,
            score: fit.clone(),
        });
    }

    placements.sort_by(|a, b| a.seat_key.cmp(&b.seat_key));

    let mut unplaced_members: Vec<i64> = members
        .iter()
        .zip(&placed_members)
        .filter_map(|(member, &placed)| (!placed).then_some(member.user_id))
        .collect();
    unplaced_members.sort_unstable();

    let mut unfilled_seats: Vec<String> = seats
        .iter()
        .zip(&filled_seats)
        .filter_map(|(seat, &filled)| (!filled).then_some(seat.seat_key.clone()))
        .collect();
    unfilled_seats.sort();

    Assignment { placements, unplaced_members, unfilled_seats }
}

/// The Hungarian algorithm (Kuhn–Munkres), maximising total weight on a rectangular matrix.
mod hungarian {
    /// Solves `weights[member][seat] -> score` for the assignment maximising the total score.
    ///
    /// Returns, per row, the column it was assigned to (or `None` when there were more rows than
    /// columns and this one was left over). Internally converts to a minimisation over a padded
    /// square cost matrix — the textbook formulation — then reads the maximising assignment back
    /// out, dropping any padding.
    ///
    /// O(n³) where n is the larger dimension. A few hundred seats is a few hundred thousand
    /// arithmetic operations: microseconds, not a scaling concern for a guild roster.
    pub(super) fn solve(weights: &[Vec<f64>]) -> Vec<Option<usize>> {
        let rows = weights.len();
        let cols = weights.first().map_or(0, Vec::len);
        if rows == 0 || cols == 0 {
            return vec![None; rows];
        }

        let n = rows.max(cols);
        let max_weight = weights
            .iter()
            .flatten()
            .copied()
            .fold(0.0_f64, f64::max);
        // Costs must be non-negative for the algorithm below; padding cells cost nothing, so an
        // unmatched real cell is always preferred over a dummy one when anything positive is on
        // offer, and equally preferred over a dummy when everything real is zero.
        let mut cost = vec![vec![max_weight; n]; n];
        for (r, row) in weights.iter().enumerate() {
            for (c, &weight) in row.iter().enumerate() {
                cost[r][c] = max_weight - weight;
            }
        }

        let assignment = solve_min_cost(&cost);

        assignment
            .into_iter()
            .take(rows)
            .map(|col| (col < cols).then_some(col))
            .collect()
    }

    /// Jonker–Volgenant-style potentials shortest-augmenting-path implementation of the Hungarian
    /// algorithm over a square non-negative cost matrix. Returns, per row, its assigned column.
    fn solve_min_cost(cost: &[Vec<f64>]) -> Vec<usize> {
        const INF: f64 = f64::INFINITY;
        let n = cost.len();

        // 1-indexed, matching the classical description exactly, to keep this auditable against
        // the reference algorithm rather than reinvented in 0-indexed arithmetic.
        let mut u = vec![0.0; n + 1];
        let mut v = vec![0.0; n + 1];
        let mut p = vec![0usize; n + 1]; // p[j] = row assigned to column j (1-indexed columns)
        let mut way = vec![0usize; n + 1];

        for i in 1..=n {
            p[0] = i;
            let mut j0 = 0usize;
            let mut minv = vec![INF; n + 1];
            let mut used = vec![false; n + 1];

            loop {
                used[j0] = true;
                let i0 = p[j0];
                let mut delta = INF;
                let mut j1 = 0usize;

                for j in 1..=n {
                    if used[j] {
                        continue;
                    }
                    let cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }

                for j in 0..=n {
                    if used[j] {
                        u[p[j]] += delta;
                        v[j] -= delta;
                    } else {
                        minv[j] -= delta;
                    }
                }

                j0 = j1;
                if p[j0] == 0 {
                    break;
                }
            }

            loop {
                let j1 = way[j0];
                p[j0] = p[j1];
                j0 = j1;
                if j0 == 0 {
                    break;
                }
            }
        }

        let mut result = vec![0usize; n];
        for j in 1..=n {
            if p[j] > 0 {
                result[p[j] - 1] = j - 1;
            }
        }
        result
    }

    #[cfg(test)]
    mod hungarian_tests {
        use super::solve;

        #[test]
        fn maximises_total_weight_on_a_square_matrix() {
            // The obviously-best pairing is (0,1) and (1,0), total 9; the diagonal totals only 2.
            let weights = vec![vec![1.0, 5.0], vec![4.0, 1.0]];
            let result = solve(&weights);
            assert_eq!(result, vec![Some(1), Some(0)]);
        }

        #[test]
        fn a_specialist_is_not_starved_by_a_generalist() {
            // Member 0 is decent everywhere; member 1 is only good at seat 1. Greedy first-fit in
            // signup order would give member 0 seat 0 by default and strand member 1's only seat
            // if member 0 were considered for it first — the optimum instead keeps member 1 on
            // their one seat and gives member 0 the other.
            let weights = vec![vec![10.0, 10.0], vec![0.0, 20.0]];
            let result = solve(&weights);
            assert_eq!(result, vec![Some(0), Some(1)]);
        }

        #[test]
        fn more_rows_than_columns_leaves_the_worst_row_unassigned() {
            let weights = vec![vec![5.0], vec![1.0], vec![9.0]];
            let result = solve(&weights);
            assert_eq!(result[2], Some(0)); // the best row keeps the only seat
            assert_eq!(result.iter().filter(|c| c.is_some()).count(), 1);
        }

        #[test]
        fn more_columns_than_rows_leaves_extra_seats_unfilled() {
            let weights = vec![vec![5.0, 1.0, 9.0]];
            let result = solve(&weights);
            assert_eq!(result, vec![Some(2)]);
        }

        #[test]
        fn an_all_zero_matrix_still_produces_a_complete_assignment() {
            let weights = vec![vec![0.0, 0.0], vec![0.0, 0.0]];
            let result = solve(&weights);
            assert_eq!(result.len(), 2);
            assert!(result.iter().all(Option::is_some));
            let assigned: std::collections::HashSet<_> = result.into_iter().flatten().collect();
            assert_eq!(assigned.len(), 2, "each seat used exactly once");
        }
    }
}

#[cfg(test)]
mod fit_tests {
    use super::{Assignment, Member, Preference, Seat, assign, score};
    use crate::modules::combat::ip::{EquippedItem, SpecLevels};
    use crate::modules::comps::status::BuildSlot;

    fn polehammer_seat(seat_key: &str, build_id: i64) -> Seat {
        Seat {
            seat_key: seat_key.to_string(),
            build_id,
            items: vec![EquippedItem {
                slot: BuildSlot::Weapon,
                base: "2H_POLEHAMMER".to_string(),
                tier: 8,
                enchantment: 0,
                quality: 1,
            }],
        }
    }

    fn member(user_id: i64, specs: &[(&str, i32)], primary: Option<i64>) -> Member {
        Member {
            user_id,
            specs: SpecLevels::from_rows(specs.iter().map(|(k, l)| (*k, *l))),
            primary_build_id: primary,
            secondary_build_id: None,
        }
    }

    #[test]
    fn spec_and_mastery_reach_most_but_not_all_of_the_ceiling() {
        // `SpecLevels::all_at(100)` maxes every node in the game, and a hammer's sibling families
        // (Great Hammer, Undead Hammer, …) each carry their own copy of the same family bonus
        // against a Polehammer — see `SpecLevels::all_at`'s docs. So maxing only the Polehammer's
        // own spec and mastery gets close to the ceiling but cannot equal it.
        let seat = polehammer_seat("build:1:1", 1);
        let specs = &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)];
        let fit = score(&member(1, specs, None), &seat);
        assert!(fit.readiness < 1.0, "got {}", fit.readiness);
        assert!(fit.readiness > 0.9, "should still be close to the ceiling: got {}", fit.readiness);
        assert!(fit.blocking.is_empty());
    }

    #[test]
    fn spec_without_mastery_scores_lower_than_spec_with_mastery() {
        let seat = polehammer_seat("build:1:1", 1);
        let spec_only = score(&member(1, &[("weapon:2H_POLEHAMMER", 100)], None), &seat);
        let with_mastery = score(
            &member(1, &[("weapon:2H_POLEHAMMER", 100), ("mastery:COMBAT_HAMMERS", 100)], None),
            &seat,
        );
        assert!(spec_only.readiness < with_mastery.readiness);
    }

    #[test]
    fn an_untrained_member_scores_low_but_not_blocked() {
        let seat = polehammer_seat("build:1:1", 1);
        let fit = score(&member(1, &[], None), &seat);
        assert!(fit.readiness < 1.0);
        assert!(fit.blocking.is_empty(), "no specialization is a low score, not an impossibility");
    }

    #[test]
    fn a_seat_with_no_items_is_reported_as_blocked() {
        let empty_seat = Seat { seat_key: "build:2:1".to_string(), build_id: 2, items: Vec::new() };
        let fit = score(&member(1, &[], None), &empty_seat);
        assert!(!fit.blocking.is_empty());
        assert!((fit.combined() - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_primary_signup_scores_above_the_same_readiness_without_it() {
        let seat = polehammer_seat("build:1:1", 1);
        let specs = &[("weapon:2H_POLEHAMMER", 50)];
        let with_preference = score(&member(1, specs, Some(1)), &seat);
        let without = score(&member(1, specs, None), &seat);
        assert!(with_preference.combined() > without.combined());
        assert_eq!(with_preference.preference, Preference::Primary);
    }

    #[test]
    fn the_specialist_keeps_their_only_seat_over_a_generalist() {
        // Member 1 has spec only for the astral staff seat; member 2 is middling everywhere.
        // A greedy first-fit that considers member 2 first for seat "astral" would strand member 1.
        let astral_seat = Seat {
            seat_key: "build:2:1".to_string(),
            build_id: 2,
            items: vec![EquippedItem {
                slot: BuildSlot::Weapon,
                base: "MAIN_ARCANESTAFF".to_string(),
                tier: 8,
                enchantment: 0,
                quality: 1,
            }],
        };
        let hammer_seat = polehammer_seat("build:1:1", 1);

        let specialist = member(1, &[("weapon:MAIN_ARCANESTAFF", 100)], None);
        let generalist = member(2, &[("weapon:2H_POLEHAMMER", 40), ("weapon:MAIN_ARCANESTAFF", 40)], None);

        let result = assign(&[specialist, generalist], &[hammer_seat, astral_seat]);
        let seat_of = |user_id: i64| {
            result
                .placements
                .iter()
                .find(|p| p.user_id == user_id)
                .map(|p| p.seat_key.clone())
        };
        assert_eq!(seat_of(1).as_deref(), Some("build:2:1"), "the specialist keeps their one fit");
        assert_eq!(seat_of(2).as_deref(), Some("build:1:1"));
        assert!(result.unplaced_members.is_empty());
        assert!(result.unfilled_seats.is_empty());
    }

    #[test]
    fn more_members_than_seats_leaves_the_rest_on_the_bench() {
        let seat = polehammer_seat("build:1:1", 1);
        let members = vec![
            member(1, &[("weapon:2H_POLEHAMMER", 100)], None),
            member(2, &[("weapon:2H_POLEHAMMER", 50)], None),
        ];
        let result = assign(&members, &[seat]);
        assert_eq!(result.placements.len(), 1);
        assert_eq!(result.placements[0].user_id, 1, "the better-trained member gets the seat");
        assert_eq!(result.unplaced_members, vec![2]);
    }

    #[test]
    fn more_seats_than_members_leaves_the_rest_unfilled() {
        let member = member(1, &[("weapon:2H_POLEHAMMER", 100)], None);
        let seats = vec![polehammer_seat("build:1:1", 1), polehammer_seat("build:1:2", 1)];
        let result = assign(std::slice::from_ref(&member), &seats);
        assert_eq!(result.placements.len(), 1);
        assert_eq!(result.unfilled_seats.len(), 1);
    }

    #[test]
    fn empty_inputs_place_nobody_and_fill_nothing() {
        let result: Assignment = assign(&[], &[]);
        assert!(result.placements.is_empty());
        assert!(result.unplaced_members.is_empty());
        assert!(result.unfilled_seats.is_empty());
    }

    #[test]
    fn assignment_is_deterministic_regardless_of_input_order() {
        let hammer = polehammer_seat("build:1:1", 1);
        let astral = Seat {
            seat_key: "build:2:1".to_string(),
            build_id: 2,
            items: vec![EquippedItem {
                slot: BuildSlot::Weapon,
                base: "MAIN_ARCANESTAFF".to_string(),
                tier: 8,
                enchantment: 0,
                quality: 1,
            }],
        };
        let a = member(1, &[("weapon:2H_POLEHAMMER", 70)], None);
        let b = member(2, &[("weapon:MAIN_ARCANESTAFF", 70)], None);

        let forward = assign(&[a.clone(), b.clone()], &[hammer.clone(), astral.clone()]);
        let reversed = assign(&[b, a], &[astral, hammer]);

        let mut forward_pairs: Vec<_> =
            forward.placements.iter().map(|p| (p.user_id, p.seat_key.clone())).collect();
        let mut reversed_pairs: Vec<_> =
            reversed.placements.iter().map(|p| (p.user_id, p.seat_key.clone())).collect();
        forward_pairs.sort();
        reversed_pairs.sort();
        assert_eq!(forward_pairs, reversed_pairs);
    }
}
