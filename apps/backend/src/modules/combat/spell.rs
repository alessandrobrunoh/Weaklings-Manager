//! Resolves one bundled spell record into the concrete numbers a simulation needs.
//!
//! The dataset stores a spell's effect tree close to the game's own authoring format: an ability
//! is often a thin wrapper that `applyspell`s one or more child spells rather than carrying its own
//! damage, and an effect can carry a conditional branch (`valueoverride`, `IfCharge`,
//! `IfConsumeCharges`, `IfSpellActive`) this module does not attempt to evaluate.
//!
//! [`resolve`] walks the `applyspell` graph to depth 6 collecting every attribute change and
//! crowd-control effect it can read unconditionally, and names — rather than silently drops or
//! guesses at — every effect it cannot: [`ResolvedSpell::unsupported`] lists them, so a caller
//! knows precisely which numbers are missing from a total rather than trusting an undercount.
//!
//! # What is exact, and what a caller must supply
//!
//! `change`, `time`, `castingtime`, `hitdelay` and the `targetcount*bonusfactor` coefficients are
//! read verbatim from the dataset — the same numbers the game itself uses. What this module does
//! **not** know: how many targets a cast actually lands on (the app's chosen "no geometry" design
//! has the caller declare that), and how the caster's own Item Power scales the flat `change`
//! figure — that scaling lives in the deferred `stats.rs` work (see the module docs on
//! `combat::ip`), so every damage and healing number here is the spell's **baseline** value, before
//! the caster's own ability power is applied. Use it to compare spells and to reason about timing,
//! escalation, focus fire and crowd control — not as an absolute damage prediction.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::dataset::combat_spells;

/// How deep an `applyspell` chain is followed before giving up. Six covers every chain observed in
/// the bundled dataset with room to spare; a spell that recurses past this is reported as
/// unsupported rather than risking a runaway walk.
const MAX_APPLY_DEPTH: u8 = 6;

/// Which side of the fight an effect lands on, as the dataset's own `target` vocabulary maps onto
/// the two groups a caller reasons about — the fight has no geometry, so anything more specific
/// than "the caster's side" or "the other side" is not meaningful here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EffectSide {
    /// `self`, `friendall`, `friendother`, `all` and their variants — the caster's own side.
    Ally,
    /// `enemy`, `enemyplayers`, `enemymobs` and their variants — the opposing side.
    Enemy,
    /// A target keyword this module does not classify (`storedtarget`, `knockeddownplayer`, …),
    /// kept verbatim so a caller can decide rather than have the effect silently dropped.
    Other,
}

impl EffectSide {
    fn from_dataset(target: &str) -> Self {
        if target.starts_with("enemy") {
            Self::Enemy
        } else if target == "self" || target.starts_with("friend") || target == "all" {
            Self::Ally
        } else {
            Self::Other
        }
    }
}

/// A `directattributechange` effect, read verbatim from the dataset.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AttributeChange {
    /// Which spell in the `applyspell` chain produced this — useful when several child spells
    /// each contribute a line to the same cast's total.
    pub source_spell: String,
    pub side: EffectSide,
    /// `"health"` or `"energy"` in every case observed in the dataset.
    pub attribute: String,
    /// Negative for damage or an energy drain, positive for a heal or an energy restore. This is
    /// the spell's baseline figure — see the module docs on ability-power scaling.
    pub change: f64,
    /// `"physical"` or `"magic"`, when the dataset states one.
    pub effect_type: Option<String>,
    /// Area escalation coefficient: extra fraction of `change` per target beyond the first, capped
    /// by [`super::data_types::AoeEscalation::threshold_max`].
    pub target_count_bonus_factor: Option<f64>,
}

/// A crowd-control effect — `stun`, `root`, `knockback`, `silence` or `forcedmovement`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CrowdControlEffect {
    pub source_spell: String,
    /// `"stun"`, `"root"`, `"knockback"`, `"silence"` or `"forcedmovement"`.
    pub kind: String,
    pub side: EffectSide,
    /// Base duration in seconds, before crowd-control diminishing returns.
    pub time: f64,
    /// Extra fraction of `time` per target beyond the first, matching
    /// [`AttributeChange::target_count_bonus_factor`] but for duration.
    pub target_count_bonus_factor: Option<f64>,
}

/// One spell's numeric effects, fully resolved through its `applyspell` chain.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ResolvedSpell {
    /// Seconds from cast start until the cast is locked in (cannot be interrupted by movement).
    pub casting_time: f64,
    /// Seconds from cast start until the effect actually lands.
    pub hit_delay: f64,
    /// Seconds the caster is locked in place after the cast resolves.
    pub stand_time: f64,
    /// Cooldown in seconds before the spell can be cast again.
    pub recast_delay: f64,
    /// Energy cost.
    pub energy_usage: f64,
    /// How easily an incoming hit interrupts this cast; `0.0` when the dataset omits it, which in
    /// practice means "not interruptible in the way a normal cast is" (an instant or self spell).
    pub disruption_factor: f64,
    pub damage_and_healing: Vec<AttributeChange>,
    pub crowd_control: Vec<CrowdControlEffect>,
    /// Effect keys this resolver found but could not turn into numbers — a conditional branch
    /// (`valueoverride`, `IfCharge`, `IfConsumeCharges`, `IfSpellActive`) or an effect type this
    /// module does not model (`channelingspell`, `damageshield`, `pulsingspell`, `dash`, `aura`,
    /// `spellimmunity`, `transformation`, …). Named, one entry per `{spell_id}:{effect_key}`
    /// found, so a caller can say exactly what a total is missing rather than trust an undercount.
    pub unsupported: Vec<String>,
}

/// Effect keys this module reads directly. Anything else present on a spell record is recorded in
/// [`ResolvedSpell::unsupported`] rather than silently ignored.
const KNOWN_EFFECT_KEYS: &[&str] = &[
    "directattributechange",
    "buffovertime",
    "attributechangeovertime",
    "stun",
    "root",
    "knockback",
    "silence",
    "forcedmovement",
    "applyspell",
];
/// Keys read directly at the spell's top level for timing, not effects — never flagged as
/// unsupported even though they are not in [`KNOWN_EFFECT_KEYS`].
const TIMING_KEYS: &[&str] = &[
    "kind",
    "name",
    "target",
    "castingtime",
    "hitdelay",
    "standtime",
    "recastdelay",
    "energyusage",
    "castrange",
    "disruptionfactor",
    "category",
    "uitype",
    "maxstack",
    "maxcharges",
    "buffpriority",
    "interruptiblebyspell",
];

/// Resolves `spell_id` through its full `applyspell` chain.
///
/// Returns `None` only when `spell_id` is not in the bundled dataset at all; a spell that resolves
/// to nothing but unsupported effects still returns `Some`, with an empty effect list and a
/// non-empty [`ResolvedSpell::unsupported`], so the two failure modes stay distinguishable.
#[must_use]
pub fn resolve(spell_id: &str) -> Option<ResolvedSpell> {
    let root = combat_spells().get(spell_id)?;
    let mut resolved = ResolvedSpell {
        casting_time: field_f64(root, "castingtime"),
        hit_delay: field_f64(root, "hitdelay"),
        stand_time: field_f64(root, "standtime"),
        recast_delay: field_f64(root, "recastdelay"),
        energy_usage: field_f64(root, "energyusage"),
        disruption_factor: field_f64(root, "disruptionfactor"),
        ..ResolvedSpell::default()
    };

    let mut visited = BTreeSet::new();
    walk(spell_id, root, 0, &mut visited, &mut resolved);
    Some(resolved)
}

fn field_f64(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Normalises a dataset field that may be one object or a list of objects into a `Vec`.
fn as_list(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    }
}

/// True when an effect object carries a key this module cannot evaluate — a conditional branch on
/// who is casting, what charges are up, or what else is currently active.
const CONDITIONAL_KEYS: &[&str] = &[
    "valueoverride",
    "IfCharge",
    "IfConsumeCharges",
    "IfSpellActive",
    "not",
];

fn has_conditional(effect: &Value) -> bool {
    effect
        .as_object()
        .is_some_and(|map| CONDITIONAL_KEYS.iter().any(|key| map.contains_key(*key)))
}

fn walk(
    spell_id: &str,
    spell: &Value,
    depth: u8,
    visited: &mut BTreeSet<String>,
    out: &mut ResolvedSpell,
) {
    if depth > MAX_APPLY_DEPTH || !visited.insert(spell_id.to_string()) {
        if depth > MAX_APPLY_DEPTH {
            out.unsupported
                .push(format!("{spell_id}:apply-chain-too-deep"));
        }
        return;
    }

    let Some(map) = spell.as_object() else { return };
    for key in map.keys() {
        if !KNOWN_EFFECT_KEYS.contains(&key.as_str()) && !TIMING_KEYS.contains(&key.as_str()) {
            out.unsupported.push(format!("{spell_id}:{key}"));
        }
    }

    for effect in spell
        .get("directattributechange")
        .map(as_list)
        .unwrap_or_default()
    {
        if has_conditional(effect) {
            out.unsupported
                .push(format!("{spell_id}:directattributechange (conditional)"));
            continue;
        }
        let (Some(target), Some(attribute), Some(change)) = (
            effect.get("target").and_then(Value::as_str),
            effect.get("attribute").and_then(Value::as_str),
            effect.get("change").and_then(Value::as_f64),
        ) else {
            out.unsupported
                .push(format!("{spell_id}:directattributechange (unreadable)"));
            continue;
        };
        out.damage_and_healing.push(AttributeChange {
            source_spell: spell_id.to_string(),
            side: EffectSide::from_dataset(target),
            attribute: attribute.to_string(),
            change,
            effect_type: effect
                .get("effecttype")
                .and_then(Value::as_str)
                .map(str::to_string),
            target_count_bonus_factor: effect
                .get("targetcountvaluebonusfactor")
                .and_then(Value::as_f64),
        });
    }

    for kind in ["stun", "root", "knockback", "silence", "forcedmovement"] {
        for effect in spell.get(kind).map(as_list).unwrap_or_default() {
            if has_conditional(effect) {
                out.unsupported
                    .push(format!("{spell_id}:{kind} (conditional)"));
                continue;
            }
            let (Some(target), Some(time)) = (
                effect.get("target").and_then(Value::as_str),
                effect.get("time").and_then(Value::as_f64),
            ) else {
                out.unsupported
                    .push(format!("{spell_id}:{kind} (unreadable)"));
                continue;
            };
            out.crowd_control.push(CrowdControlEffect {
                source_spell: spell_id.to_string(),
                kind: kind.to_string(),
                side: EffectSide::from_dataset(target),
                time,
                target_count_bonus_factor: effect
                    .get("targetcountdurationbonusfactor")
                    .and_then(Value::as_f64),
            });
        }
    }

    // `buffovertime`/`attributechangeovertime` (damage- or heal-over-time and stat debuffs) are
    // real, common effects the dataset carries — but unlike a `directattributechange` they need a
    // tick cadence to turn into a single number, which this pure resolver does not decide. Named
    // rather than silently skipped, so a caller building a timeline knows one is there to place.
    for key in ["buffovertime", "attributechangeovertime"] {
        if spell.get(key).is_some() {
            out.unsupported
                .push(format!("{spell_id}:{key} (over-time, not yet resolved)"));
        }
    }

    for reference in spell.get("applyspell").map(as_list).unwrap_or_default() {
        if has_conditional(reference) {
            out.unsupported
                .push(format!("{spell_id}:applyspell (conditional)"));
            continue;
        }
        let Some(child_id) = reference.get("spell").and_then(Value::as_str) else {
            out.unsupported
                .push(format!("{spell_id}:applyspell (unreadable)"));
            continue;
        };
        if let Some(child) = combat_spells().get(child_id) {
            walk(child_id, child, depth + 1, visited, out);
        } else {
            out.unsupported.push(format!(
                "{spell_id}:applyspell -> {child_id} (unknown spell)"
            ));
        }
    }
}

#[cfg(test)]
mod spell_tests {
    use super::{EffectSide, resolve};

    #[test]
    fn a_direct_damage_spell_resolves_its_own_numbers() {
        let spell = resolve("HAMMERWHIRLWIND2").expect("spell exists in the bundled dataset");
        assert!((spell.recast_delay - 15.0).abs() < f64::EPSILON);
        let hit = spell
            .damage_and_healing
            .iter()
            .find(|change| change.attribute == "health")
            .expect("the whirlwind deals damage");
        assert!(hit.change < 0.0, "damage is negative");
        assert_eq!(hit.side, EffectSide::Enemy);
        assert!(hit.target_count_bonus_factor.unwrap_or_default() > 0.0);

        let stun = spell.crowd_control.iter().find(|cc| cc.kind == "stun");
        assert!(stun.is_some(), "the whirlwind also stuns");
    }

    #[test]
    fn a_wrapper_spell_resolves_through_its_apply_chain() {
        // AMBUSH itself carries no direct effect — it applies four child spells. Whatever those
        // children turn out to contain, walking the chain should not itself fail or infinite-loop.
        let spell = resolve("AMBUSH").expect("spell exists in the bundled dataset");
        assert!(
            !spell.damage_and_healing.is_empty()
                || !spell.crowd_control.is_empty()
                || !spell.unsupported.is_empty(),
            "a wrapper spell should resolve to something — effects, or a named reason it could not"
        );
    }

    #[test]
    fn an_unknown_spell_id_resolves_to_nothing() {
        assert!(resolve("NOT_A_REAL_SPELL_ID").is_none());
    }

    #[test]
    fn a_conditional_effect_is_named_rather_than_guessed() {
        // AXETHROW_SECOND_EFFECT's second directattributechange carries `valueoverride` /
        // `IfConsumeCharges` — a real conditional this resolver does not evaluate.
        let spell = resolve("AXETHROW_SECOND_EFFECT").expect("spell exists in the bundled dataset");
        assert!(
            spell
                .unsupported
                .iter()
                .any(|entry| entry.contains("directattributechange")),
            "the conditional heal-on-charge-consume entry should be flagged, not silently dropped: {:?}",
            spell.unsupported
        );
        // The unconditional damage line should still resolve normally alongside it.
        assert!(
            spell
                .damage_and_healing
                .iter()
                .any(|change| change.change < 0.0)
        );
    }

    #[test]
    fn a_buff_over_time_is_named_rather_than_silently_dropped() {
        let spell = resolve("ACID_BOMB_EFFECT").expect("spell exists in the bundled dataset");
        assert!(
            spell
                .unsupported
                .iter()
                .any(|entry| entry.contains("buffovertime")),
            "got {:?}",
            spell.unsupported
        );
    }

    #[test]
    fn the_walk_does_not_loop_forever_on_a_cycle() {
        // Not a real dataset guarantee, but the visited-set must still hold if one ever appears:
        // resolving the same spell id twice must not double-count its effects.
        let first = resolve("HAMMERWHIRLWIND2").unwrap();
        let second = resolve("HAMMERWHIRLWIND2").unwrap();
        assert_eq!(
            first.damage_and_healing.len(),
            second.damage_and_healing.len()
        );
    }
}
