//! Which member fits which seat, and the optimal assignment across a whole roster.
//!
//! Pure over plain structs — no database, no async — so the scoring and the assignment algorithm
//! are each unit-testable on their own. The service layer above this turns `event_participations`,
//! `canonical_comp_seats` and `user_weapons` into [`Member`] and [`Seat`]; nothing here knows those
//! tables exist.
//!
//! A member fits a seat through the weapons they declared ("My weapons"): the proficiency they
//! gave the seat's weapon decides the score, an officer lock forbids the pairing, and the signup
//! preference breaks ties.
//!
//! # Why Hungarian, not greedy
//!
//! `auto_fill_roster` today is first-fit: it walks participants in signup order and gives each the
//! first seat matching their preferred build. That is provably wrong the moment two members are
//! both the only viable pilot for two different seats — the one who signed up first eats a seat the
//! other member also fits, and the seat that actually needed the second member's weapon goes
//! unfilled or falls back to someone worse.
//!
//! [`assign`] instead solves the whole matrix at once with the Kuhn–Munkres (Hungarian) algorithm,
//! O(n³) on a square matrix padded with zero-cost dummies. A guild roster is bounded by
//! `events.player_cap` and the seat-numbering scheme (`party = index / 20 + 1`) to realistically at
//! most a couple hundred seats, so a few hundred thousand operations costs microseconds — there is
//! no scale at which the naive approach would be justified by speed.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ip::EquippedItem;
use backend_entities::status::comps::BuildSlot;
use backend_identity::users::weapons::{UserWeaponSet, WeaponProficiency};

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
    /// Additive bonus a preference contributes to a score.
    ///
    /// Smaller than the step between two proficiency levels (1.0), so a preference breaks a tie in
    /// the preferred direction without overriding a member who declared a better level on the
    /// seat's weapon than the one who asked for the build.
    const fn bonus(self) -> f64 {
        match self {
            Self::None => 0.0,
            Self::Secondary => 0.25,
            Self::Primary => 0.5,
        }
    }
}

/// Score of a member who declared no weapons at all: unknown, but still placeable.
const UNKNOWN_SCORE: f64 = 0.5;

/// Score of a member who declared weapons, none of them the seat's: possible as a last resort.
const OTHER_WEAPON_SCORE: f64 = 0.1;

/// The weapons a member declared and the ones an officer locked for them.
///
/// Locks are a hard rule for assignment (a locked weapon's seat is never filled by the member);
/// declarations decide how well the member fits a seat.
#[derive(Debug, Clone, Default)]
pub struct MemberWeapons {
    levels: HashMap<String, WeaponProficiency>,
    locked: HashSet<String>,
}

impl MemberWeapons {
    /// Builds the assignment view of a member's stored weapon rows.
    #[must_use]
    pub fn from_set(set: &UserWeaponSet) -> Self {
        let mut weapons = Self::default();
        for (key, standing) in set.iter() {
            if let Some(level) = standing.proficiency {
                weapons.levels.insert(key.to_string(), level);
            }
            if standing.locked {
                weapons.locked.insert(key.to_string());
            }
        }
        weapons
    }

    /// Whether an officer locked this weapon for the member.
    #[must_use]
    pub fn is_locked(&self, weapon_key: &str) -> bool {
        self.locked.contains(weapon_key)
    }

    /// The level the member declared for this weapon, if any.
    #[must_use]
    pub fn proficiency(&self, weapon_key: &str) -> Option<WeaponProficiency> {
        self.levels.get(weapon_key).copied()
    }

    /// Whether the member declared at least one weapon.
    #[must_use]
    pub fn has_declared_any(&self) -> bool {
        !self.levels.is_empty()
    }
}

/// One member available to be seated.
#[derive(Debug, Clone)]
pub struct Member {
    /// Internal user id.
    pub user_id: i64,
    /// The build they signed up as primary, if any.
    pub primary_build_id: Option<i64>,
    /// The build they signed up as secondary, if any.
    pub secondary_build_id: Option<i64>,
    /// The weapons they declared, and the ones an officer locked for them.
    pub weapons: MemberWeapons,
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

impl Seat {
    /// `weapon:{BASE}` of the weapon the seat's build carries, when its loadout has one.
    #[must_use]
    pub fn weapon_key(&self) -> Option<String> {
        self.items
            .iter()
            .find(|item| item.slot == BuildSlot::Weapon && !item.base.is_empty())
            .map(|item| format!("weapon:{}", item.base))
    }
}

/// How well one member fits one seat.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FitScore {
    /// The level the member declared on the seat's weapon, `None` when they did not declare it
    /// (or the seat has no recognisable weapon).
    pub proficiency: Option<WeaponProficiency>,
    /// The member's signup preference for this seat's build.
    pub preference: Preference,
    /// Reasons this pairing cannot be made, empty when it can.
    pub blocking: Vec<String>,
    /// Higher is a better fit. Declared proficiency on the seat's weapon scores `main` 3, `good`
    /// 2, `basic` 1; a member who declared no weapons at all scores 0.5 and one who declared only
    /// other weapons 0.1; a primary signup adds 0.5 and a secondary one 0.25.
    pub score: f64,
}

impl FitScore {
    /// The number the assignment algorithm actually optimises: the score, or zero when the
    /// pairing is blocked.
    #[must_use]
    pub fn combined(&self) -> f64 {
        if self.blocking.is_empty() {
            self.score
        } else {
            0.0
        }
    }
}

/// Scores one member against one seat.
///
/// Never fails: a seat with no data behind it, or a member who declared nothing, comes back as a
/// real (low) score rather than an error, because "this pairing is bad" and "this pairing is
/// impossible" are different facts the caller needs told apart.
#[must_use]
pub fn score(member: &Member, seat: &Seat) -> FitScore {
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

    let mut proficiency = None;
    let base = if let Some(weapon_key) = seat.weapon_key() {
        // A weapon an officer locked for the member is a hard rule.
        if member.weapons.is_locked(&weapon_key) {
            blocking.push("an officer locked this weapon for the member".to_string());
        }
        proficiency = member.weapons.proficiency(&weapon_key);
        match proficiency {
            Some(level) => f64::from(level.rank()),
            None if member.weapons.has_declared_any() => OTHER_WEAPON_SCORE,
            None => UNKNOWN_SCORE,
        }
    } else {
        UNKNOWN_SCORE
    };

    FitScore {
        proficiency,
        preference,
        blocking,
        score: base + preference.bonus(),
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
    BestFit,
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

    let scores: Vec<Vec<FitScore>> = members
        .iter()
        .map(|member| seats.iter().map(|seat| score(member, seat)).collect())
        .collect();

    let assignment = hungarian::solve(
        &scores
            .iter()
            .map(|row| row.iter().map(FitScore::combined).collect())
            .collect::<Vec<Vec<f64>>>(),
    );

    let mut placements = Vec::new();
    let mut placed_members = vec![false; members.len()];
    let mut filled_seats = vec![false; seats.len()];

    for (member_index, seat_index) in assignment.into_iter().enumerate() {
        let Some(seat_index) = seat_index else {
            continue;
        };
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

    Assignment {
        placements,
        unplaced_members,
        unfilled_seats,
    }
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
        let max_weight = weights.iter().flatten().copied().fold(0.0_f64, f64::max);
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
    use super::{Assignment, Member, MemberWeapons, Preference, Seat, assign, score};
    use crate::ip::EquippedItem;
    use backend_entities::status::comps::BuildSlot;
    use backend_identity::users::weapons::{self, UserWeaponSet, WeaponProficiency};

    const HAMMER: &str = "weapon:2H_POLEHAMMER";
    const STAFF: &str = "weapon:MAIN_ARCANESTAFF";

    fn seat_of_weapon(seat_key: &str, build_id: i64, base: &str) -> Seat {
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

    fn polehammer_seat(seat_key: &str, build_id: i64) -> Seat {
        seat_of_weapon(seat_key, build_id, "2H_POLEHAMMER")
    }

    fn staff_seat(seat_key: &str, build_id: i64) -> Seat {
        seat_of_weapon(seat_key, build_id, "MAIN_ARCANESTAFF")
    }

    fn member(user_id: i64, primary: Option<i64>) -> Member {
        Member {
            user_id,
            primary_build_id: primary,
            secondary_build_id: None,
            weapons: MemberWeapons::default(),
        }
    }

    fn with_weapons(
        mut member: Member,
        declared: &[(&str, WeaponProficiency)],
        locked: &[&str],
    ) -> Member {
        let mut rows = Vec::new();
        for (key, level) in declared {
            rows.push(row(key, Some(level.as_str()), false));
        }
        for key in locked {
            rows.push(row(key, None, true));
        }
        member.weapons = MemberWeapons::from_set(&UserWeaponSet::from_rows(&rows));
        member
    }

    fn row(weapon_key: &str, proficiency: Option<&str>, locked: bool) -> weapons::Model {
        weapons::Model {
            id: 0,
            user_id: 0,
            weapon_key: weapon_key.to_string(),
            proficiency: proficiency.map(str::to_string),
            locked,
            locked_by_user_id: None,
            updated_at: chrono::Utc::now().into(),
            updated_by_user_id: None,
        }
    }

    fn declared(user_id: i64, key: &str, level: WeaponProficiency) -> Member {
        with_weapons(member(user_id, None), &[(key, level)], &[])
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn declared_proficiency_on_the_seats_weapon_decides_the_score() {
        let seat = polehammer_seat("build:1:1", 1);
        let main = score(&declared(1, HAMMER, WeaponProficiency::Main), &seat);
        let good = score(&declared(2, HAMMER, WeaponProficiency::Good), &seat);
        let basic = score(&declared(3, HAMMER, WeaponProficiency::Basic), &seat);

        assert_close(main.score, 3.0);
        assert_close(good.score, 2.0);
        assert_close(basic.score, 1.0);
        assert_eq!(main.proficiency, Some(WeaponProficiency::Main));
        assert!(main.blocking.is_empty());
        assert!(main.combined() > good.combined());
        assert!(good.combined() > basic.combined());
    }

    #[test]
    fn a_member_with_no_declared_weapons_is_unknown_but_placeable() {
        let seat = polehammer_seat("build:1:1", 1);
        let fit = score(&member(1, None), &seat);
        assert_close(fit.score, 0.5);
        assert_eq!(fit.proficiency, None);
        assert!(fit.blocking.is_empty());
    }

    #[test]
    fn declaring_only_other_weapons_ranks_below_declaring_nothing() {
        let seat = polehammer_seat("build:1:1", 1);
        let unknown = score(&member(1, None), &seat);
        let other = score(&declared(2, STAFF, WeaponProficiency::Main), &seat);
        let basic = score(&declared(3, HAMMER, WeaponProficiency::Basic), &seat);

        assert_close(other.score, 0.1);
        assert_eq!(other.proficiency, None);
        assert!(other.blocking.is_empty(), "a last resort, not impossible");
        assert!(unknown.combined() > other.combined());
        assert!(basic.combined() > unknown.combined());
    }

    #[test]
    fn a_seat_without_a_recognisable_weapon_scores_unknown_for_everyone() {
        let seat = Seat {
            seat_key: "build:3:1".to_string(),
            build_id: 3,
            items: vec![EquippedItem {
                slot: BuildSlot::Head,
                base: "HEAD_PLATE_SET1".to_string(),
                tier: 8,
                enchantment: 0,
                quality: 1,
            }],
        };
        let fit = score(&declared(1, HAMMER, WeaponProficiency::Main), &seat);
        assert_close(fit.score, 0.5);
        assert_eq!(fit.proficiency, None);
        assert!(fit.blocking.is_empty());
    }

    #[test]
    fn a_seat_with_no_items_is_reported_as_blocked() {
        let empty_seat = Seat {
            seat_key: "build:2:1".to_string(),
            build_id: 2,
            items: Vec::new(),
        };
        let fit = score(&member(1, None), &empty_seat);
        assert!(!fit.blocking.is_empty());
        assert!(fit.combined().abs() < f64::EPSILON);
    }

    #[test]
    fn a_locked_weapon_blocks_the_seat_for_that_member_only() {
        let seat = polehammer_seat("build:1:1", 1);
        let locked = with_weapons(member(1, None), &[], &[HAMMER]);
        let fit = score(&locked, &seat);
        assert!(!fit.blocking.is_empty());
        assert!(fit.combined().abs() < f64::EPSILON);

        let free = score(&declared(2, HAMMER, WeaponProficiency::Basic), &seat);
        assert!(free.blocking.is_empty());
    }

    #[test]
    fn a_preference_adds_to_the_score_and_breaks_a_tie() {
        let seat = polehammer_seat("build:1:1", 1);
        let plain = declared(1, HAMMER, WeaponProficiency::Good);
        let mut secondary = declared(2, HAMMER, WeaponProficiency::Good);
        secondary.secondary_build_id = Some(1);
        let mut primary = declared(3, HAMMER, WeaponProficiency::Good);
        primary.primary_build_id = Some(1);

        let plain_fit = score(&plain, &seat);
        let secondary_fit = score(&secondary, &seat);
        let primary_fit = score(&primary, &seat);
        assert_eq!(plain_fit.preference, Preference::None);
        assert_eq!(secondary_fit.preference, Preference::Secondary);
        assert_eq!(primary_fit.preference, Preference::Primary);
        assert_close(secondary_fit.score, 2.25);
        assert_close(primary_fit.score, 2.5);

        let result = assign(&[plain, secondary, primary], std::slice::from_ref(&seat));
        assert_eq!(result.placements[0].user_id, 3);
    }

    #[test]
    fn a_preference_does_not_outweigh_a_better_declared_level() {
        let seat = polehammer_seat("build:1:1", 1);
        let mut good_but_asked = declared(1, HAMMER, WeaponProficiency::Good);
        good_but_asked.primary_build_id = Some(1);
        let main = declared(2, HAMMER, WeaponProficiency::Main);

        let result = assign(&[good_but_asked, main], std::slice::from_ref(&seat));
        assert_eq!(result.placements[0].user_id, 2);
    }

    #[test]
    fn best_fit_keeps_the_specialist_on_their_only_seat() {
        // Member 1 only plays the staff; member 2 is good on both. A first-fit that considers
        // member 2 first for the staff seat would strand member 1 on a seat they never declared.
        let hammer_seat = polehammer_seat("build:1:1", 1);
        let astral_seat = staff_seat("build:2:1", 2);

        let specialist = declared(1, STAFF, WeaponProficiency::Main);
        let generalist = with_weapons(
            member(2, None),
            &[
                (HAMMER, WeaponProficiency::Good),
                (STAFF, WeaponProficiency::Good),
            ],
            &[],
        );

        let result = assign(&[specialist, generalist], &[hammer_seat, astral_seat]);
        let seat_of = |user_id: i64| {
            result
                .placements
                .iter()
                .find(|p| p.user_id == user_id)
                .map(|p| p.seat_key.clone())
        };
        assert_eq!(seat_of(1).as_deref(), Some("build:2:1"));
        assert_eq!(seat_of(2).as_deref(), Some("build:1:1"));
        assert!(result.unplaced_members.is_empty());
        assert!(result.unfilled_seats.is_empty());
    }

    #[test]
    fn more_members_than_seats_leaves_the_rest_on_the_bench() {
        let seat = polehammer_seat("build:1:1", 1);
        let members = vec![
            declared(1, HAMMER, WeaponProficiency::Main),
            declared(2, HAMMER, WeaponProficiency::Basic),
        ];
        let result = assign(&members, &[seat]);
        assert_eq!(result.placements.len(), 1);
        assert_eq!(
            result.placements[0].user_id, 1,
            "the member who plays it best gets the seat"
        );
        assert_eq!(result.unplaced_members, vec![2]);
    }

    #[test]
    fn more_seats_than_members_leaves_the_rest_unfilled() {
        let member = declared(1, HAMMER, WeaponProficiency::Main);
        let seats = vec![
            polehammer_seat("build:1:1", 1),
            polehammer_seat("build:1:2", 1),
        ];
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
        let astral = staff_seat("build:2:1", 2);
        let a = declared(1, HAMMER, WeaponProficiency::Good);
        let b = declared(2, STAFF, WeaponProficiency::Good);

        let forward = assign(&[a.clone(), b.clone()], &[hammer.clone(), astral.clone()]);
        let reversed = assign(&[b, a], &[astral, hammer]);

        let mut forward_pairs: Vec<_> = forward
            .placements
            .iter()
            .map(|p| (p.user_id, p.seat_key.clone()))
            .collect();
        let mut reversed_pairs: Vec<_> = reversed
            .placements
            .iter()
            .map(|p| (p.user_id, p.seat_key.clone()))
            .collect();
        forward_pairs.sort();
        reversed_pairs.sort();
        assert_eq!(forward_pairs, reversed_pairs);
    }

    #[test]
    fn a_seat_reports_the_weapon_of_its_loadout() {
        assert_eq!(
            polehammer_seat("build:1:1", 1).weapon_key().as_deref(),
            Some(HAMMER)
        );
        let unarmed = Seat {
            seat_key: "build:2:1".to_string(),
            build_id: 2,
            items: Vec::new(),
        };
        assert_eq!(unarmed.weapon_key(), None);
    }

    #[test]
    fn auto_assignment_never_seats_a_member_on_a_weapon_locked_for_them() {
        let seat = polehammer_seat("build:1:1", 1);
        // The locked member signed up for the build, and still must not take the seat.
        let locked = with_weapons(member(1, Some(1)), &[], &[HAMMER]);
        let weaker = declared(2, HAMMER, WeaponProficiency::Basic);
        let result = assign(&[locked.clone(), weaker], std::slice::from_ref(&seat));
        assert_eq!(result.placements.len(), 1);
        assert_eq!(result.placements[0].user_id, 2);
        assert_eq!(result.unplaced_members, vec![1]);

        let alone = assign(&[locked], &[seat]);
        assert!(
            alone.placements.is_empty(),
            "a lone locked member is left on the bench"
        );
        assert_eq!(alone.unfilled_seats, vec!["build:1:1".to_string()]);
    }
}
