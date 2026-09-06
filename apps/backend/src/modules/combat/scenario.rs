//! Runs a whole declared burst window — several unit groups, a timeline of casts naming explicit
//! targets — and threads each named target's hit points down over time to answer "does this kill".
//!
//! This is the layer above [`super::sim`]: `sim::resolve_cast` is a pure function of context the
//! caller supplies in full (concurrent attackers, prior crowd control); this module *computes* that
//! context from the timeline itself, because here the caller has already named which unit every
//! cast hits. That is the whole value a scenario adds over calling `sim::resolve_cast` by hand —
//! declare the casts and their targets once, and focus fire, crowd-control stacking and the zerg
//! debuff all fall out of the timeline rather than needing to be worked out by hand per cast.
//!
//! # What is exact, what is declared, and what is simplified
//!
//! Area escalation, focus fire, the zerg debuff and crowd-control diminishing returns are the exact
//! dataset tables [`super::sim`] already applies. Three things are **not** computed and must be
//! declared honestly by the caller: a unit's hit points (deriving them from Item Power needs the
//! deferred `stats.rs` calibration — see `combat::ip`'s docs), which units a cast hits (no
//! geometry), and each cast's [`super::sim::AttackerStyle`] (melee/ranged/mounted is a property of
//! the caster's own weapon, not inferable from a spell id alone).
//!
//! One simplification, inherited from [`super::sim::DeclaredCast`]'s single `prior_cc_stacks`
//! field: when a spell applies more than one *kind* of crowd control at once, this module computes
//! diminishing returns against whichever kind appears first on the resolved spell, applying that
//! one stack count to every kind the cast happens to also carry. Multi-kind single-cast crowd
//! control is rare enough in the bundled dataset that this does not warrant widening `sim`'s API.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::dataset::combat_rules;
use super::sim::{self, AttackerStyle, SideCounts};
use super::spell;

/// Which side of the fight a unit group belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Ally,
    Enemy,
}

/// One group of identical units — "5 Polehammers", "1 Great Holy Staff".
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UnitGroup {
    /// Stable id this group's units and casts are addressed by. Unit instances are
    /// `"{id}#0"`..`"{id}#{count-1}"`.
    pub id: String,
    pub side: Side,
    /// Display label, e.g. `"Polehammer"`. Not interpreted.
    pub label: String,
    /// The Albion catalog base identifier the caller resolved this group's label and spell choices
    /// from (e.g. `"2H_POLEHAMMER"`), if any. Purely a UI hint for reconstructing which weapon and
    /// ability picker to show on reload — the engine never reads it, so an absent, unknown, or
    /// stale value never affects a run.
    #[serde(default)]
    pub item_id: Option<String>,
    /// How many identical units this group has.
    #[serde(default = "one_u32")]
    pub count: u32,
    /// Hit points per unit, declared by the caller — see the module's honesty ledger.
    #[serde(default = "default_hit_points")]
    pub hit_points: f64,
}

const fn one_u32() -> u32 {
    1
}
const fn default_hit_points() -> f64 {
    1200.0 // The base character value; see `combat::data_types::CharacterDefaults`.
}

/// One cast in the timeline, naming its own targets explicitly.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeclaredCast {
    /// The [`UnitGroup::id`] doing the casting.
    pub caster_group_id: String,
    pub spell_id: String,
    /// Seconds into the burst window the cast starts.
    pub cast_at: f64,
    /// The exact unit instance ids this cast hits — see the module docs on why this replaces
    /// [`super::sim::DeclaredCast::target_count`] with something explicit.
    pub target_ids: Vec<String>,
    /// Which auto-attack category this caster's damage is measured against for focus fire.
    #[serde(default = "AttackerStyle::default_melee")]
    pub attacker_style: AttackerStyle,
}

/// One unit instance's fate over the whole burst.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UnitOutcome {
    /// `"{group_id}#{n}"`.
    pub id: String,
    pub group_id: String,
    pub group_label: String,
    pub side: Side,
    pub starting_hp: f64,
    /// Total damage received, uncapped — can exceed `starting_hp`; see [`ScenarioResult::overkill_ratio`].
    pub damage_taken: f64,
    pub healing_received: f64,
    /// `(starting_hp - damage_taken + healing_received)`, clamped at `0`.
    pub remaining_hp: f64,
    /// When this unit's `remaining_hp` first reached `0`, if it did.
    pub died_at: Option<f64>,
}

/// One cast, resolved in context, with the automatically-derived numbers that made it so.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ResolvedCastLog {
    pub caster_group_id: String,
    pub spell_id: String,
    /// `cast_at + hit_delay` — when the effect actually lands, and the order casts are processed
    /// in.
    pub land_at: f64,
    pub target_ids: Vec<String>,
    /// Total attackers found hitting one of this cast's targets within the focus-fire lookback
    /// window, **including this cast itself** — the exact value passed to
    /// [`super::sim::DeclaredCast::concurrent_attackers`].
    pub concurrent_attackers: u32,
    /// How many earlier same-kind crowd-control applications on this cast's targets were found
    /// within the diminishing-returns decay window.
    pub prior_cc_stacks: u32,
    pub escalation_multiplier: f64,
    pub focus_fire_reduction: f64,
    /// The resolved change applied to *each* named target — not a pooled total. A cast naming
    /// three targets deals this figure to every one of them.
    pub per_target_health_change: f64,
    pub crowd_control: Vec<sim::ResolvedCrowdControl>,
    pub unsupported: Vec<String>,
}

/// The whole burst, resolved. Persisted verbatim as one `combat_runs.result_json` row, so this
/// derives `Deserialize` as well as `Serialize` — see [`crate::modules::combat::service`]'s
/// `get_run`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScenarioResult {
    /// One entry per unit instance, in group declaration order.
    pub units: Vec<UnitOutcome>,
    /// One entry per cast that resolved, ordered by `land_at`.
    pub casts: Vec<ResolvedCastLog>,
    pub total_damage_dealt: f64,
    pub total_healing_done: f64,
    pub deaths: u32,
    /// Mean `died_at` across units that died, `None` when nobody did.
    pub average_time_to_kill: Option<f64>,
    /// Fraction of `total_damage_dealt` that landed on a target already at `0` hit points —
    /// `0.0` when every dead unit died from its exact lethal hit or nobody died.
    pub overkill_ratio: f64,
    /// Casts whose `spell_id` is not in the bundled dataset at all.
    pub unknown_spells: Vec<String>,
    /// Casts dropped for naming no targets at all — nothing to apply them to.
    pub casts_with_no_targets: Vec<String>,
}

/// One cast already landed, kept around so a later cast can be measured against it: whether it
/// shared a target (focus fire) and, for crowd control, whether it was the same kind (diminishing
/// returns).
struct Landed {
    land_at: f64,
    target_ids: Vec<String>,
    cc_kinds: Vec<String>,
}

/// Expands every group into its individual unit instances, keyed by `"{group.id}#{n}"`, in
/// declaration order.
fn expand_units(groups: &[UnitGroup]) -> (Vec<String>, HashMap<String, UnitOutcome>) {
    let mut order = Vec::new();
    let mut units = HashMap::new();
    for group in groups {
        for n in 0..group.count {
            let id = format!("{}#{n}", group.id);
            order.push(id.clone());
            units.insert(
                id.clone(),
                UnitOutcome {
                    id,
                    group_id: group.id.clone(),
                    group_label: group.label.clone(),
                    side: group.side,
                    starting_hp: group.hit_points,
                    damage_taken: 0.0,
                    healing_received: 0.0,
                    remaining_hp: group.hit_points,
                    died_at: None,
                },
            );
        }
    }
    (order, units)
}

/// Resolves every cast's spell up front (needed for `hit_delay`) and sorts by landing time, so the
/// main loop can process strictly in the order effects actually take hold.
///
/// Casts naming no targets, or a spell the dataset does not know, are pulled out here rather than
/// entering the timeline at all.
fn resolve_timing<'a>(
    casts: &'a [DeclaredCast],
    unknown_spells: &mut Vec<String>,
    casts_with_no_targets: &mut Vec<String>,
) -> Vec<(f64, &'a DeclaredCast, spell::ResolvedSpell)> {
    let mut timed = Vec::new();
    for cast in casts {
        if cast.target_ids.is_empty() {
            casts_with_no_targets.push(cast.spell_id.clone());
            continue;
        }
        let Some(resolved) = spell::resolve(&cast.spell_id) else {
            unknown_spells.push(cast.spell_id.clone());
            continue;
        };
        let land_at = cast.cast_at + resolved.hit_delay;
        timed.push((land_at, cast, resolved));
    }
    timed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    timed
}

/// Counts prior landed casts that overlap `target_ids` within `window` seconds before `land_at`,
/// optionally restricted to a crowd-control `kind`. The shared core of both
/// [`concurrent_attackers`] and [`prior_cc_stacks`].
fn overlapping_within(
    landed: &[Landed],
    land_at: f64,
    window: f64,
    target_ids: &[String],
    kind: Option<&str>,
) -> u32 {
    u32::try_from(
        landed
            .iter()
            .filter(|entry| {
                entry.land_at <= land_at
                    && land_at - entry.land_at <= window
                    && kind.is_none_or(|k| entry.cc_kinds.iter().any(|found| found == k))
                    && entry.target_ids.iter().any(|id| target_ids.contains(id))
            })
            .count(),
    )
    .unwrap_or(u32::MAX)
}

/// Total attackers on this cast's targets within the focus-fire lookback window, including this
/// cast itself — the exact contract `sim::DeclaredCast::concurrent_attackers` documents.
fn concurrent_attackers(landed: &[Landed], land_at: f64, target_ids: &[String]) -> u32 {
    1 + overlapping_within(
        landed,
        land_at,
        combat_rules().focus_fire.lookback_seconds,
        target_ids,
        None,
    )
}

/// Prior same-kind crowd-control applications on this cast's targets within that kind's
/// diminishing-returns decay window. `None` when the resolved spell applies no crowd control at
/// all — see the module docs on the single-kind simplification this inherits from `sim`.
fn prior_cc_stacks(
    landed: &[Landed],
    land_at: f64,
    target_ids: &[String],
    kind: Option<&str>,
) -> u32 {
    let Some(kind) = kind else { return 0 };
    let decay = combat_rules()
        .cc_diminishing_returns
        .factors
        .get(&format!("decreasetime{kind}"))
        .copied()
        .unwrap_or(0.0);
    overlapping_within(landed, land_at, decay, target_ids, Some(kind))
}

/// Applies one resolved cast's health change to every unit it named, updating `damage_taken` /
/// `healing_received` / `remaining_hp` and recording the moment a unit first reaches `0`.
fn apply_health_change(
    units: &mut HashMap<String, UnitOutcome>,
    target_ids: &[String],
    change: f64,
    land_at: f64,
) {
    for target_id in target_ids {
        let Some(unit) = units.get_mut(target_id) else {
            continue;
        };
        if change < 0.0 {
            unit.damage_taken += -change;
        } else {
            unit.healing_received += change;
        }
        unit.remaining_hp = (unit.starting_hp - unit.damage_taken + unit.healing_received).max(0.0);
        if unit.remaining_hp <= 0.0 && unit.died_at.is_none() {
            unit.died_at = Some(land_at);
        }
    }
}

/// Rolls the finished per-unit ledger up into the summary figures.
// Force sizes and unit counts stay far below f64's 52-bit mantissa; none of these casts can lose
// precision at the scale a combat test operates at.
#[allow(clippy::cast_precision_loss)]
fn summarize(units: &[UnitOutcome]) -> (f64, f64, u32, Option<f64>, f64) {
    let total_damage_dealt: f64 = units.iter().map(|u| u.damage_taken).sum();
    let total_healing_done: f64 = units.iter().map(|u| u.healing_received).sum();
    let dead: Vec<&UnitOutcome> = units.iter().filter(|u| u.died_at.is_some()).collect();
    let deaths = u32::try_from(dead.len()).unwrap_or(u32::MAX);
    let average_time_to_kill = (!dead.is_empty())
        .then(|| dead.iter().filter_map(|u| u.died_at).sum::<f64>() / dead.len() as f64);
    let overkill: f64 = dead
        .iter()
        .map(|u| (u.damage_taken - u.starting_hp).max(0.0))
        .sum();
    let overkill_ratio = if total_damage_dealt > 0.0 {
        overkill / total_damage_dealt
    } else {
        0.0
    };
    (
        total_damage_dealt,
        total_healing_done,
        deaths,
        average_time_to_kill,
        overkill_ratio,
    )
}

/// Runs the declared groups and timeline, returning the full per-unit and per-cast breakdown.
#[must_use]
pub fn run(groups: &[UnitGroup], casts: &[DeclaredCast]) -> ScenarioResult {
    let (unit_order, mut units) = expand_units(groups);
    let sides = SideCounts {
        ally_count: groups
            .iter()
            .filter(|g| g.side == Side::Ally)
            .map(|g| g.count)
            .sum(),
        enemy_count: groups
            .iter()
            .filter(|g| g.side == Side::Enemy)
            .map(|g| g.count)
            .sum(),
    };

    let mut unknown_spells = Vec::new();
    let mut casts_with_no_targets = Vec::new();
    let timed = resolve_timing(casts, &mut unknown_spells, &mut casts_with_no_targets);

    let mut landed: Vec<Landed> = Vec::new();
    let mut log = Vec::with_capacity(timed.len());

    for (land_at, cast, resolved_spell) in timed {
        let attackers = concurrent_attackers(&landed, land_at, &cast.target_ids);
        let first_kind = resolved_spell
            .crowd_control
            .first()
            .map(|cc| cc.kind.as_str());
        let cc_stacks = prior_cc_stacks(&landed, land_at, &cast.target_ids, first_kind);

        let sim_cast = sim::DeclaredCast {
            caster_label: cast.caster_group_id.clone(),
            spell_id: cast.spell_id.clone(),
            cast_at: cast.cast_at,
            target_count: u32::try_from(cast.target_ids.len()).unwrap_or(u32::MAX),
            concurrent_attackers: attackers,
            attacker_style: cast.attacker_style,
            prior_cc_stacks: cc_stacks,
        };
        let Some(outcome) = sim::resolve_cast(&sim_cast, sides) else {
            unknown_spells.push(cast.spell_id.clone());
            continue;
        };

        let health_change = outcome
            .attribute_changes
            .iter()
            .find(|c| c.attribute == "health")
            .map_or(0.0, |c| c.resolved_change);
        apply_health_change(&mut units, &cast.target_ids, health_change, land_at);

        landed.push(Landed {
            land_at,
            target_ids: cast.target_ids.clone(),
            cc_kinds: outcome
                .crowd_control
                .iter()
                .map(|cc| cc.kind.clone())
                .collect(),
        });

        log.push(ResolvedCastLog {
            caster_group_id: cast.caster_group_id.clone(),
            spell_id: cast.spell_id.clone(),
            land_at,
            target_ids: cast.target_ids.clone(),
            concurrent_attackers: attackers,
            prior_cc_stacks: cc_stacks,
            escalation_multiplier: outcome.escalation_multiplier,
            focus_fire_reduction: outcome.focus_fire_reduction,
            per_target_health_change: health_change,
            crowd_control: outcome.crowd_control,
            unsupported: outcome.unsupported,
        });
    }

    let ordered_units: Vec<UnitOutcome> = unit_order
        .iter()
        .filter_map(|id| units.remove(id))
        .collect();
    let (total_damage_dealt, total_healing_done, deaths, average_time_to_kill, overkill_ratio) =
        summarize(&ordered_units);

    ScenarioResult {
        units: ordered_units,
        casts: log,
        total_damage_dealt,
        total_healing_done,
        deaths,
        average_time_to_kill,
        overkill_ratio,
        unknown_spells,
        casts_with_no_targets,
    }
}

#[cfg(test)]
mod scenario_tests {
    use super::{DeclaredCast, Side, UnitGroup, run};
    use crate::modules::combat::sim::AttackerStyle;

    fn ally_hammers(count: u32) -> UnitGroup {
        UnitGroup {
            id: "ally-hammer".to_string(),
            side: Side::Ally,
            label: "Polehammer".to_string(),
            item_id: None,
            count,
            hit_points: 1200.0,
        }
    }

    fn enemy_plate(count: u32, hit_points: f64) -> UnitGroup {
        UnitGroup {
            id: "enemy-plate".to_string(),
            side: Side::Enemy,
            label: "Plate".to_string(),
            item_id: None,
            count,
            hit_points,
        }
    }

    fn cast(caster: &str, spell_id: &str, cast_at: f64, targets: &[&str]) -> DeclaredCast {
        DeclaredCast {
            caster_group_id: caster.to_string(),
            spell_id: spell_id.to_string(),
            cast_at,
            target_ids: targets.iter().map(|t| (*t).to_string()).collect(),
            attacker_style: AttackerStyle::Melee,
        }
    }

    #[test]
    fn a_lethal_hit_kills_and_records_when() {
        // HAMMERWHIRLWIND2's baseline hit is -66.6; 50 HP guarantees a kill without relying on
        // the exact figure, which is a dataset value this test should not need to hand-compute.
        let groups = [ally_hammers(1), enemy_plate(1, 50.0)];
        let casts = [cast(
            "ally-hammer",
            "HAMMERWHIRLWIND2",
            0.0,
            &["enemy-plate#0"],
        )];
        let result = run(&groups, &casts);
        assert_eq!(result.deaths, 1);
        let target = result
            .units
            .iter()
            .find(|u| u.id == "enemy-plate#0")
            .unwrap();
        assert!(target.died_at.is_some());
        assert!((target.remaining_hp - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_survivable_hit_leaves_the_target_alive() {
        let groups = [ally_hammers(1), enemy_plate(1, 100_000.0)];
        let casts = [cast(
            "ally-hammer",
            "HAMMERWHIRLWIND2",
            0.0,
            &["enemy-plate#0"],
        )];
        let result = run(&groups, &casts);
        assert_eq!(result.deaths, 0);
        let target = &result.units[1];
        assert!(target.died_at.is_none());
        assert!(target.remaining_hp > 0.0);
    }

    #[test]
    fn the_same_hit_lands_on_every_named_target_not_split_between_them() {
        let groups = [ally_hammers(1), enemy_plate(3, 100_000.0)];
        let casts = [cast(
            "ally-hammer",
            "HAMMERWHIRLWIND2",
            0.0,
            &["enemy-plate#0", "enemy-plate#1", "enemy-plate#2"],
        )];
        let result = run(&groups, &casts);
        let damages: Vec<f64> = result.units[1..].iter().map(|u| u.damage_taken).collect();
        assert!((damages[0] - damages[1]).abs() < 1e-9);
        assert!((damages[1] - damages[2]).abs() < 1e-9);
        assert!(damages[0] > 0.0);
    }

    #[test]
    fn a_repeated_cast_on_the_same_target_earns_focus_fire_protection() {
        let groups = [ally_hammers(6), enemy_plate(1, 1_000_000.0)];
        let mut casts = Vec::new();
        for n in 0..6 {
            casts.push(cast(
                &format!("ally-hammer-{n}"),
                "HAMMERWHIRLWIND2",
                0.0,
                &["enemy-plate#0"],
            ));
        }
        let result = run(&groups, &casts);
        let first = &result.casts[0];
        let last = &result.casts[5];
        // "Including this cast itself": the first lands alone (1), the sixth lands as the sixth
        // simultaneous attacker (6) — matching the focus-fire table's own convention exactly, per
        // the value already hand-verified in `sim::sim_tests::six_attackers_matches_the_focus_fire_table`.
        assert_eq!(first.concurrent_attackers, 1);
        assert_eq!(last.concurrent_attackers, 6);
        assert!(
            (last.focus_fire_reduction - 0.466).abs() < 1e-9,
            "got {}",
            last.focus_fire_reduction
        );
        assert!((first.focus_fire_reduction - 0.0).abs() < 1e-9);
    }

    #[test]
    fn repeated_stuns_on_the_same_target_diminish() {
        let groups = [ally_hammers(2), enemy_plate(1, 1_000_000.0)];
        let casts = [
            cast("ally-hammer", "HAMMERWHIRLWIND2", 0.0, &["enemy-plate#0"]),
            cast("ally-hammer", "HAMMERWHIRLWIND2", 1.0, &["enemy-plate#0"]),
        ];
        let result = run(&groups, &casts);
        let first_stun = result.casts[0]
            .crowd_control
            .iter()
            .find(|cc| cc.kind == "stun")
            .unwrap();
        let second_stun = result.casts[1]
            .crowd_control
            .iter()
            .find(|cc| cc.kind == "stun")
            .unwrap();
        assert!(second_stun.resolved_time < first_stun.resolved_time);
        assert_eq!(result.casts[1].prior_cc_stacks, 1);
    }

    #[test]
    fn overkill_ratio_reports_wasted_damage_on_an_already_dead_target() {
        let groups = [ally_hammers(3), enemy_plate(1, 1.0)]; // one HP: the very first hit overkills massively
        let casts = [
            cast("ally-hammer", "HAMMERWHIRLWIND2", 0.0, &["enemy-plate#0"]),
            cast("ally-hammer", "HAMMERWHIRLWIND2", 1.0, &["enemy-plate#0"]),
        ];
        let result = run(&groups, &casts);
        assert_eq!(result.deaths, 1);
        assert!(result.overkill_ratio > 0.9, "got {}", result.overkill_ratio);
    }

    #[test]
    fn an_unknown_spell_is_reported_and_does_not_crash_the_run() {
        let groups = [ally_hammers(1), enemy_plate(1, 1000.0)];
        let casts = [cast(
            "ally-hammer",
            "NOT_A_REAL_SPELL",
            0.0,
            &["enemy-plate#0"],
        )];
        let result = run(&groups, &casts);
        assert_eq!(result.unknown_spells, vec!["NOT_A_REAL_SPELL".to_string()]);
        assert!(result.casts.is_empty());
    }

    #[test]
    fn a_cast_with_no_targets_is_dropped_and_reported_rather_than_applied() {
        let groups = [ally_hammers(1), enemy_plate(1, 1000.0)];
        let casts = [cast("ally-hammer", "HAMMERWHIRLWIND2", 0.0, &[])];
        let result = run(&groups, &casts);
        assert_eq!(
            result.casts_with_no_targets,
            vec!["HAMMERWHIRLWIND2".to_string()]
        );
        assert!(result.casts.is_empty());
    }

    #[test]
    fn casts_are_reported_in_landing_order_not_declaration_order() {
        let groups = [ally_hammers(1), enemy_plate(1, 1_000_000.0)];
        // Declared out of order: the later cast_at comes first in the request.
        let casts = [
            cast("ally-hammer", "HAMMERWHIRLWIND2", 5.0, &["enemy-plate#0"]),
            cast("ally-hammer", "HAMMERWHIRLWIND2", 0.0, &["enemy-plate#0"]),
        ];
        let result = run(&groups, &casts);
        assert!(result.casts[0].land_at < result.casts[1].land_at);
    }

    #[test]
    fn no_units_and_no_casts_produce_an_empty_but_valid_result() {
        let result = run(&[], &[]);
        assert!(result.units.is_empty());
        assert!(result.casts.is_empty());
        assert_eq!(result.deaths, 0);
        assert!(result.average_time_to_kill.is_none());
        assert!((result.overkill_ratio - 0.0).abs() < f64::EPSILON);
    }
}
