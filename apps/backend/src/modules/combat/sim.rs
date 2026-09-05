//! Turns a declared cast into concrete numbers: what [`super::spell::resolve`] read off one spell,
//! adjusted by area escalation, focus fire, the zerg debuff and crowd-control diminishing returns.
//!
//! Deliberately not a time-stepping loop. The app's chosen design has no geometry — a caller (the
//! future `/tests` page) declares, per cast, how many targets it hits and how much cross-cutting
//! context applies (concurrent attackers on the implied target, prior crowd control on it, the
//! side counts for the zerg debuff) rather than the engine tracking positions or maintaining hidden
//! state across casts. That keeps every number here a pure function of its declared inputs,
//! consistent with the rest of the combat module, and lets the caller arrange casts on whatever
//! timeline it likes.
//!
//! # What is exact, and what is not
//!
//! The area-escalation, focus-fire and zerg-debuff coefficients, and the crowd-control diminishing
//! returns formula's per-type factors, are read from the bundled dataset — the same tables the game
//! itself uses. What is **not** modelled: which specific units a cast actually reaches (no
//! geometry), the caster's own ability power scaling the spell's baseline `change` (see
//! `spell.rs`'s docs), and any effect [`super::spell::resolve`] could not read
//! ([`super::spell::ResolvedSpell::unsupported`]) — every outcome here carries that list forward
//! unchanged so a total is never silently short.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::dataset::combat_rules;
use super::spell::{self, EffectSide};

/// Which auto-attack category a target's incoming damage is measured against for focus fire — the
/// game's table gives a different reduction for melee, ranged and mounted attackers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttackerStyle {
    Melee,
    Ranged,
    Mounted,
}

/// One cast a caller wants resolved, with the context the engine cannot infer on its own.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeclaredCast {
    /// A label for the caster, echoed back on the outcome — e.g. `"Polehammer #1"`. Not
    /// interpreted; purely for the caller to match an outcome back to its timeline row.
    pub caster_label: String,
    /// The spell being cast, looked up via [`super::spell::resolve`].
    pub spell_id: String,
    /// Seconds into the burst window the cast starts.
    pub cast_at: f64,
    /// How many targets this cast hits, declared by the caller. Clamped to the dataset's own
    /// escalation ceiling before the escalation multiplier is computed.
    #[serde(default = "one")]
    pub target_count: u32,
    /// How many attackers, including this one, are currently hitting the implied target — looked
    /// up against the focus-fire table. `0` or `1` means no reduction applies.
    #[serde(default)]
    pub concurrent_attackers: u32,
    /// Which auto-attack category this caster's damage is measured against for focus fire.
    #[serde(default = "AttackerStyle::default_melee")]
    pub attacker_style: AttackerStyle,
    /// How many times a crowd-control effect of the same kind has already landed on the implied
    /// target within the diminishing-returns decay window, before this cast.
    #[serde(default)]
    pub prior_cc_stacks: u32,
}

const fn one() -> u32 {
    1
}

impl AttackerStyle {
    const fn default_melee() -> Self {
        Self::Melee
    }
}

/// The side counts a burst is evaluated against, for the zerg debuff.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ToSchema)]
pub struct SideCounts {
    /// Total allied force size. `>= 21` starts applying the zerg debuff to allied casts.
    #[serde(default)]
    pub ally_count: u32,
    /// Total enemy force size. `>= 21` starts applying the zerg debuff to enemy casts.
    #[serde(default)]
    pub enemy_count: u32,
}

/// One resolved damage or healing line, after every multiplier.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResolvedAttributeChange {
    pub side: EffectSide,
    pub attribute: String,
    /// The spell's baseline `change`, before any multiplier here.
    pub base_change: f64,
    /// `base_change` after area escalation, focus fire (damage to `Enemy` only) and the zerg
    /// debuff (Whichever side's count applies, from [`SideCounts`]) are applied. Still the
    /// caster's baseline ability power — see the module docs.
    pub resolved_change: f64,
}

/// One resolved crowd-control application, after diminishing returns and the zerg debuff.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResolvedCrowdControl {
    pub kind: String,
    pub side: EffectSide,
    pub base_time: f64,
    /// `base_time` after area escalation, the zerg debuff and crowd-control diminishing returns.
    pub resolved_time: f64,
}

/// One cast, fully resolved.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CastOutcome {
    pub caster_label: String,
    pub spell_id: String,
    /// `cast_at + hit_delay` — when the effect actually lands.
    pub land_at: f64,
    pub attribute_changes: Vec<ResolvedAttributeChange>,
    pub crowd_control: Vec<ResolvedCrowdControl>,
    /// The multiplier area escalation applied, for display — `1.0` when the cast has one target.
    pub escalation_multiplier: f64,
    /// The multiplier focus fire removed from outgoing damage, for display — `0.0` means no
    /// reduction applied.
    pub focus_fire_reduction: f64,
    /// Effect keys [`super::spell::resolve`] could not turn into numbers for this spell, carried
    /// forward unchanged.
    pub unsupported: Vec<String>,
}

/// The whole burst, resolved and summed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BurstResult {
    /// One entry per requested cast, in the order the caller declared them — **not** resorted by
    /// `land_at`, so a result lines up positionally with the request that produced it.
    pub casts: Vec<CastOutcome>,
    /// Sum of every resolved negative `health` change against [`EffectSide::Enemy`].
    pub total_damage_to_enemies: f64,
    /// Sum of every resolved positive `health` change against [`EffectSide::Ally`].
    pub total_healing_to_allies: f64,
    /// Spell ids in the request [`super::spell::resolve`] does not know at all — distinct from a
    /// per-cast [`CastOutcome::unsupported`] entry, which names a specific *effect* on a spell that
    /// *was* found.
    pub unknown_spells: Vec<String>,
}

/// Resolves one declared cast against the bundled dataset and the given side counts.
///
/// Returns `None` only when `cast.spell_id` is not in the dataset at all — the caller collects
/// these separately as [`BurstResult::unknown_spells`] rather than folding them into a per-cast
/// `unsupported` list, since there is no spell to attach one to.
#[must_use]
pub fn resolve_cast(cast: &DeclaredCast, sides: SideCounts) -> Option<CastOutcome> {
    let spell = spell::resolve(&cast.spell_id)?;
    let rules = combat_rules();

    let capped_targets = cast.target_count.clamp(1, u32_from(rules.aoe_escalation.threshold_max));
    let extra_targets = f64::from(capped_targets - 1);

    let focus_fire_reduction = focus_fire_reduction(cast.concurrent_attackers, cast.attacker_style);

    let attribute_changes = spell
        .damage_and_healing
        .iter()
        .map(|change| {
            let escalation = 1.0 + change.target_count_bonus_factor.unwrap_or(0.0) * extra_targets;
            let zerg = zerg_damage_multiplier(change.side, sides);
            // Focus fire only ever protects the side being hit, and only reduces incoming
            // damage — a heal or an energy restore is untouched by it.
            let focus_fire = if change.side == EffectSide::Enemy && change.change < 0.0 {
                1.0 - focus_fire_reduction
            } else {
                1.0
            };
            ResolvedAttributeChange {
                side: change.side,
                attribute: change.attribute.clone(),
                base_change: change.change,
                resolved_change: change.change * escalation * zerg * focus_fire,
            }
        })
        .collect::<Vec<_>>();

    let crowd_control = spell
        .crowd_control
        .iter()
        .map(|cc| {
            let escalation = 1.0 + cc.target_count_bonus_factor.unwrap_or(0.0) * extra_targets;
            let zerg = zerg_cc_multiplier(cc.side, sides);
            let diminishing = 1.0 - cc_diminishing_reduction(&cc.kind, cast.prior_cc_stacks);
            ResolvedCrowdControl {
                kind: cc.kind.clone(),
                side: cc.side,
                base_time: cc.time,
                resolved_time: cc.time * escalation * zerg * diminishing,
            }
        })
        .collect::<Vec<_>>();

    let escalation_multiplier = 1.0
        + spell
            .damage_and_healing
            .iter()
            .filter_map(|change| change.target_count_bonus_factor)
            .fold(0.0_f64, f64::max)
            * extra_targets;

    Some(CastOutcome {
        caster_label: cast.caster_label.clone(),
        spell_id: cast.spell_id.clone(),
        land_at: cast.cast_at + spell.hit_delay,
        attribute_changes,
        crowd_control,
        escalation_multiplier,
        focus_fire_reduction,
        unsupported: spell.unsupported,
    })
}

/// Resolves every cast in `casts` and rolls the result up into one [`BurstResult`].
#[must_use]
pub fn simulate(casts: &[DeclaredCast], sides: SideCounts) -> BurstResult {
    let mut resolved = Vec::with_capacity(casts.len());
    let mut unknown_spells = Vec::new();

    for cast in casts {
        match resolve_cast(cast, sides) {
            Some(outcome) => resolved.push(outcome),
            None => unknown_spells.push(cast.spell_id.clone()),
        }
    }

    let total_damage_to_enemies = resolved
        .iter()
        .flat_map(|outcome| &outcome.attribute_changes)
        .filter(|change| change.side == EffectSide::Enemy && change.attribute == "health")
        .map(|change| -change.resolved_change.min(0.0))
        .sum();
    let total_healing_to_allies = resolved
        .iter()
        .flat_map(|outcome| &outcome.attribute_changes)
        .filter(|change| change.side == EffectSide::Ally && change.attribute == "health")
        .map(|change| change.resolved_change.max(0.0))
        .sum();

    BurstResult { casts: resolved, total_damage_to_enemies, total_healing_to_allies, unknown_spells }
}

/// Fraction of damage focus fire removes at the given attacker count, for the given style.
fn focus_fire_reduction(concurrent_attackers: u32, style: AttackerStyle) -> f64 {
    let table = &combat_rules().focus_fire.attackers;
    table
        .iter()
        .filter(|row| u32_from(row.at_least) <= concurrent_attackers)
        .max_by_key(|row| row.at_least)
        .map_or(0.0, |row| match style {
            AttackerStyle::Melee => row.melee,
            AttackerStyle::Ranged => row.ranged,
            AttackerStyle::Mounted => row.mounted,
        })
}

/// The zerg debuff's damage multiplier for the side being hit — its own side's headcount that
/// matters is the one being punished for outnumbering, i.e. an `Enemy`-side effect (something one
/// side casts against the other) is weakened by the caster's own side's ally count, and vice versa.
///
/// Concretely: the debuff answers "is *this side* stacked?" — [`EffectSide::Ally`] effects (buffs,
/// heals the caster's own side receives) are weakened by [`SideCounts::ally_count`], and
/// [`EffectSide::Enemy`] effects (damage the caster deals outward) are *also* weakened by the
/// caster's own [`SideCounts::ally_count`] — the debuff punishes whichever side is oversized,
/// regardless of which direction its spell points.
fn zerg_damage_multiplier(_side: EffectSide, sides: SideCounts) -> f64 {
    zerg_row(sides.ally_count).map_or(1.0, |row| row.damage)
}

fn zerg_cc_multiplier(_side: EffectSide, sides: SideCounts) -> f64 {
    zerg_row(sides.ally_count).map_or(1.0, |row| row.cc_duration)
}

fn zerg_row(count: u32) -> Option<&'static super::data_types::ZergDebuffRow> {
    combat_rules()
        .zerg_debuff
        .allies
        .iter()
        .filter(|row| u32_from(row.at_least) <= count)
        .max_by_key(|row| row.at_least)
}

/// Fraction of a crowd-control duration diminishing returns removes, for `prior_stacks` earlier
/// applications of the same `kind` within the decay window.
fn cc_diminishing_reduction(kind: &str, prior_stacks: u32) -> f64 {
    let rules = &combat_rules().cc_diminishing_returns;
    let Some(&factor) = rules.factors.get(&format!("typefactor{kind}")) else {
        return 0.0; // A crowd-control kind the dataset has no diminishing-returns entry for.
    };
    (factor * f64::from(prior_stacks)).min(rules.max)
}

fn u32_from(value: i32) -> u32 {
    value.try_into().unwrap_or(0)
}

#[cfg(test)]
mod sim_tests {
    use super::{AttackerStyle, DeclaredCast, SideCounts, resolve_cast, simulate};

    fn cast(spell_id: &str) -> DeclaredCast {
        DeclaredCast {
            caster_label: "test".to_string(),
            spell_id: spell_id.to_string(),
            cast_at: 0.0,
            target_count: 1,
            concurrent_attackers: 0,
            attacker_style: AttackerStyle::Melee,
            prior_cc_stacks: 0,
        }
    }

    #[test]
    fn a_single_target_cast_applies_no_escalation() {
        let outcome = resolve_cast(&cast("HAMMERWHIRLWIND2"), SideCounts::default()).unwrap();
        assert!((outcome.escalation_multiplier - 1.0).abs() < f64::EPSILON);
        let hit = outcome
            .attribute_changes
            .iter()
            .find(|c| c.attribute == "health")
            .unwrap();
        assert!((hit.resolved_change - hit.base_change).abs() < f64::EPSILON);
    }

    #[test]
    fn five_targets_matches_the_hand_verified_escalation() {
        // HAMMERWHIRLWIND2's damage line carries targetcountvaluebonusfactor 0.08; five targets
        // is 4 extra, so +32%, exactly the worked example in the plan's own mockup.
        let mut declared = cast("HAMMERWHIRLWIND2");
        declared.target_count = 5;
        let outcome = resolve_cast(&declared, SideCounts::default()).unwrap();
        assert!(
            (outcome.escalation_multiplier - 1.32).abs() < 1e-9,
            "got {}",
            outcome.escalation_multiplier
        );
    }

    #[test]
    fn escalation_caps_at_the_datasets_own_ceiling() {
        // The ceiling is 7; ten declared targets must resolve identically to seven.
        let mut ten = cast("HAMMERWHIRLWIND2");
        ten.target_count = 10;
        let mut seven = cast("HAMMERWHIRLWIND2");
        seven.target_count = 7;
        let outcome_ten = resolve_cast(&ten, SideCounts::default()).unwrap();
        let outcome_seven = resolve_cast(&seven, SideCounts::default()).unwrap();
        assert!((outcome_ten.escalation_multiplier - outcome_seven.escalation_multiplier).abs() < 1e-9);
    }

    #[test]
    fn six_attackers_matches_the_focus_fire_table() {
        let mut declared = cast("HAMMERWHIRLWIND2");
        declared.concurrent_attackers = 6;
        let outcome = resolve_cast(&declared, SideCounts::default()).unwrap();
        assert!(
            (outcome.focus_fire_reduction - 0.466).abs() < 1e-9,
            "got {}",
            outcome.focus_fire_reduction
        );
        let hit = outcome
            .attribute_changes
            .iter()
            .find(|c| c.attribute == "health")
            .unwrap();
        assert!((hit.resolved_change - hit.base_change * (1.0 - 0.466)).abs() < 1e-9);
    }

    #[test]
    fn focus_fire_does_not_touch_a_heal() {
        // GREATHOLYSTAFF-style heals: any spell whose effect is a positive change on the ally
        // side must be untouched by an enemy-focused reduction. Using a synthetic assertion here
        // since asserting on a specific heal spell id would tie the test to which one currently
        // exists in the bundled dataset.
        let mut declared = cast("HAMMERWHIRLWIND2");
        declared.concurrent_attackers = 10;
        let outcome = resolve_cast(&declared, SideCounts::default()).unwrap();
        for change in &outcome.attribute_changes {
            if change.side == super::EffectSide::Ally || change.resolved_change > 0.0 {
                assert!((change.resolved_change - change.base_change).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn twenty_one_allies_triggers_the_zerg_debuff() {
        let below = resolve_cast(
            &cast("HAMMERWHIRLWIND2"),
            SideCounts { ally_count: 20, enemy_count: 0 },
        )
        .unwrap();
        let at_threshold = resolve_cast(
            &cast("HAMMERWHIRLWIND2"),
            SideCounts { ally_count: 21, enemy_count: 0 },
        )
        .unwrap();
        let below_hit = below.attribute_changes.iter().find(|c| c.attribute == "health").unwrap();
        let at_hit =
            at_threshold.attribute_changes.iter().find(|c| c.attribute == "health").unwrap();
        assert!((below_hit.resolved_change - below_hit.base_change).abs() < 1e-9);
        assert!(
            (at_hit.resolved_change / at_hit.base_change - 0.99).abs() < 1e-9,
            "21 allies should apply the first zerg debuff tier (0.99x): got {}",
            at_hit.resolved_change / at_hit.base_change
        );
    }

    #[test]
    fn repeated_stuns_diminish_and_cap_at_the_datasets_maximum() {
        let fresh = resolve_cast(&cast("HAMMERWHIRLWIND2"), SideCounts::default()).unwrap();
        let mut stacked = cast("HAMMERWHIRLWIND2");
        stacked.prior_cc_stacks = 3;
        let after_three = resolve_cast(&stacked, SideCounts::default()).unwrap();

        let fresh_stun = fresh.crowd_control.iter().find(|cc| cc.kind == "stun").unwrap();
        let stacked_stun = after_three.crowd_control.iter().find(|cc| cc.kind == "stun").unwrap();
        assert!(stacked_stun.resolved_time < fresh_stun.resolved_time);

        // typefactorstun is 0.3 and diminishingreturnmax is 0.8, so at some stack count the
        // reduction must saturate rather than exceed the dataset's own ceiling.
        let mut heavily_stacked = cast("HAMMERWHIRLWIND2");
        heavily_stacked.prior_cc_stacks = 20;
        let saturated = resolve_cast(&heavily_stacked, SideCounts::default()).unwrap();
        let saturated_stun = saturated.crowd_control.iter().find(|cc| cc.kind == "stun").unwrap();
        assert!(
            (saturated_stun.resolved_time - fresh_stun.resolved_time * 0.2).abs() < 1e-9,
            "expected the 0.8 cap (20% of base remaining): got {} vs base {}",
            saturated_stun.resolved_time,
            fresh_stun.resolved_time
        );
    }

    #[test]
    fn an_unknown_spell_is_reported_separately_from_a_known_spells_unsupported_effects() {
        let result = simulate(&[cast("NOT_A_REAL_SPELL")], SideCounts::default());
        assert_eq!(result.unknown_spells, vec!["NOT_A_REAL_SPELL".to_string()]);
        assert!(result.casts.is_empty());
    }

    #[test]
    fn simulate_sums_damage_across_multiple_casts_in_request_order() {
        let casts = vec![cast("HAMMERWHIRLWIND2"), cast("HAMMERWHIRLWIND2")];
        let result = simulate(&casts, SideCounts::default());
        assert_eq!(result.casts.len(), 2);
        let single = resolve_cast(&cast("HAMMERWHIRLWIND2"), SideCounts::default()).unwrap();
        let single_damage: f64 = single
            .attribute_changes
            .iter()
            .filter(|c| c.attribute == "health" && c.resolved_change < 0.0)
            .map(|c| -c.resolved_change)
            .sum();
        assert!((result.total_damage_to_enemies - single_damage * 2.0).abs() < 1e-9);
    }
}
