//! Pure, DB-free equipment fingerprinting.
//!
//! A fingerprint is an equipment identity computed from already-persisted
//! evidence for one battle participant: either the full set of slots
//! recovered from a victim's death equipment (see
//! `battles::evidence_entities::battle_kill_item`), or — for a player who
//! never died — just their observed main-hand weapon (see
//! `battles::evidence_entities::battle_player_stat::main_hand_item_id`).
//!
//! This module only computes and matches; it does not read or write
//! anything. A later integration step is responsible for turning real query
//! results into [`KillItemSource`]/[`BuildCandidate`] values and persisting
//! [`ComputedFingerprint`] into whatever `loadout_fingerprints`-shaped table
//! a parallel migration task creates.

use std::collections::BTreeMap;

use crate::modules::intel::roles::{RoleClassifier, normalize_item_id};

/// One occupied equipment slot from a victim's death equipment.
///
/// `upstream_slot` is the raw `PascalCase` key as observed in the kill feed's
/// equipment JSON (e.g. `"MainHand"`), not yet mapped to the build-side
/// `snake_case` slot key. `item_type_id` is the raw upstream item string (e.g.
/// `"T8_2H_HOLYSTAFF_MORGANA@3"`), not yet tier/enchantment-stripped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillItemSource {
    /// Raw upstream equipment slot key, e.g. `"MainHand"`.
    pub upstream_slot: String,
    /// Raw upstream item type id, not yet base-normalized.
    pub item_type_id: String,
}

/// One internal build's one loadout, flattened to a slot -> base item map.
///
/// One `BuildCandidate` per `(build_id, loadout)` pair, so a build's main
/// and swap loadouts are independent, separately scoreable candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildCandidate {
    /// The internal build id this loadout belongs to.
    pub build_id: i64,
    /// Which loadout of the build this is: `"main"` or `"swap"`.
    pub loadout: String,
    /// Build-side slot key (e.g. `"weapon"`, `"off_hand"`) -> base item id.
    pub slots: BTreeMap<String, String>,
}

/// Which evidence a fingerprint was computed from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FingerprintMode {
    /// Computed from a full set of death-equipment slots.
    Full,
    /// Computed from just an observed main-hand weapon, for a player who
    /// never died in the battle.
    WeaponOnly,
}

/// The outcome of matching a fingerprint against the internal build catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchStatus {
    /// Exactly one candidate agreed on every commonly-populated slot and had
    /// the largest overlap with the observed slots.
    Matched,
    /// Two or more candidates tied for the largest agreeing overlap.
    Ambiguous,
    /// No candidate shared any slot with the observed set, or none of the
    /// candidates that did agreed on every one of them.
    Unmatched,
}

/// A computed, ready-to-persist equipment fingerprint plus its match result.
#[derive(Debug, Clone, PartialEq)]
pub struct ComputedFingerprint {
    /// Canonical `"slot:item|slot:item"` string, sorted by slot key.
    pub fingerprint: String,
    /// Which evidence this fingerprint was computed from.
    pub mode: FingerprintMode,
    /// Base (tier/enchantment-stripped) item id of the main-hand weapon.
    pub main_hand_base_item_id: String,
    /// Role classified from `main_hand_base_item_id`. Always `Some` — a
    /// fingerprint cannot exist without a weapon slot.
    pub primary_role: Option<String>,
    /// Build-side slot key -> base item id, sorted by slot key.
    pub slots: BTreeMap<String, String>,
    /// The internal build id this fingerprint matched, when unambiguous.
    pub matched_build_id: Option<i64>,
    /// The matched build's loadout (`"main"` or `"swap"`), when unambiguous.
    pub matched_build_loadout: Option<String>,
    /// The outcome of matching against the catalog.
    pub match_status: MatchStatus,
}

/// Maps an upstream `PascalCase` equipment slot key to the build-side
/// lowercase `snake_case` slot key used by `build_items.slot`
/// (`comps::status::BuildSlot::as_str`).
///
/// `None` for any key not in the fixed 10-slot table — a messy upstream
/// payload's unrecognized slot is simply dropped from the fingerprint rather
/// than breaking the whole computation.
fn map_upstream_slot(upstream_slot: &str) -> Option<&'static str> {
    match upstream_slot {
        "MainHand" => Some("weapon"),
        "OffHand" => Some("off_hand"),
        "Head" => Some("head"),
        "Armor" => Some("armor"),
        "Shoes" => Some("shoes"),
        "Cape" => Some("cape"),
        "Bag" => Some("bag"),
        "Potion" => Some("potion"),
        "Food" => Some("food"),
        "Mount" => Some("mount"),
        _ => None,
    }
}

/// Renders a slot map as the canonical `"slot:item|slot:item"` fingerprint
/// string. `BTreeMap`'s iteration order over `String` keys is already
/// lexicographic, so no separate sort is needed.
fn render_fingerprint(slots: &BTreeMap<String, String>) -> String {
    slots
        .iter()
        .map(|(slot, item)| format!("{slot}:{item}"))
        .collect::<Vec<_>>()
        .join("|")
}

/// Computes a full equipment fingerprint from a victim's death equipment.
///
/// Returns `None` when the mapped-and-normalized slots carry no `"weapon"`
/// entry — this can legitimately happen when a victim's equipment JSON never
/// carried a `MainHand` entry, and a fingerprint without a weapon cannot be
/// built.
#[must_use]
pub fn compute_full_fingerprint(
    items: &[KillItemSource],
    classifier: &RoleClassifier,
) -> Option<ComputedFingerprint> {
    let mut slots = BTreeMap::new();
    for item in items {
        let Some(build_slot) = map_upstream_slot(&item.upstream_slot) else {
            continue;
        };
        slots.insert(
            build_slot.to_string(),
            normalize_item_id(&item.item_type_id),
        );
    }

    let main_hand_base_item_id = slots.get("weapon").cloned()?;
    let (role, _) = classifier.classify(&main_hand_base_item_id);
    let fingerprint = render_fingerprint(&slots);

    Some(ComputedFingerprint {
        fingerprint,
        mode: FingerprintMode::Full,
        main_hand_base_item_id,
        primary_role: Some(role.as_str().to_string()),
        slots,
        matched_build_id: None,
        matched_build_loadout: None,
        match_status: MatchStatus::Unmatched,
    })
}

/// Computes a weapon-only fingerprint for a player who never died in the
/// battle, from their observed main-hand weapon alone.
#[must_use]
pub fn compute_weapon_only_fingerprint(
    main_hand_item_id: &str,
    classifier: &RoleClassifier,
) -> ComputedFingerprint {
    let normalized = normalize_item_id(main_hand_item_id);
    let mut slots = BTreeMap::new();
    slots.insert("weapon".to_string(), normalized.clone());
    let (role, _) = classifier.classify(&normalized);
    let fingerprint = format!("weapon:{normalized}");

    ComputedFingerprint {
        fingerprint,
        mode: FingerprintMode::WeaponOnly,
        main_hand_base_item_id: normalized,
        primary_role: Some(role.as_str().to_string()),
        slots,
        matched_build_id: None,
        matched_build_loadout: None,
        match_status: MatchStatus::Unmatched,
    }
}

/// Matches an observed slot map against the internal build catalog.
///
/// Algorithm: for each candidate, compute the overlap (slot keys present in
/// both the observed set and the candidate). A candidate with no overlap is
/// disqualified outright; a candidate that disagrees with the observed value
/// on even one overlapping slot is disqualified entirely (a strict
/// "every commonly-populated slot must agree" rule, not a fuzzy score).
/// Surviving candidates are scored by overlap size; the candidate(s) with the
/// maximum score decide the outcome: none survive -> `Unmatched`, exactly one
/// at the maximum -> `Matched`, two or more tied at the maximum ->
/// `Ambiguous`.
#[must_use]
pub fn match_against_catalog(
    observed_slots: &BTreeMap<String, String>,
    candidates: &[BuildCandidate],
) -> (Option<i64>, Option<String>, MatchStatus) {
    let mut best_score = 0usize;
    let mut best: Vec<&BuildCandidate> = Vec::new();

    for candidate in candidates {
        let overlap: Vec<&str> = observed_slots
            .keys()
            .filter(|slot| candidate.slots.contains_key(slot.as_str()))
            .map(String::as_str)
            .collect();
        if overlap.is_empty() {
            continue;
        }
        let all_agree = overlap
            .iter()
            .all(|slot| observed_slots.get(*slot) == candidate.slots.get(*slot));
        if !all_agree {
            continue;
        }

        let score = overlap.len();
        if score > best_score {
            best_score = score;
            best.clear();
            best.push(candidate);
        } else if score == best_score {
            best.push(candidate);
        }
    }

    match best.as_slice() {
        [] => (None, None, MatchStatus::Unmatched),
        [only] => (
            Some(only.build_id),
            Some(only.loadout.clone()),
            MatchStatus::Matched,
        ),
        _ => (None, None, MatchStatus::Ambiguous),
    }
}

/// Orchestrates fingerprint computation and catalog matching for one
/// participant, preferring full death-equipment evidence over the
/// weapon-only fallback.
///
/// Prefers `kill_items` (via [`compute_full_fingerprint`]) when `Some` and it
/// successfully produces a fingerprint; otherwise falls back to
/// `main_hand_item_id` (via [`compute_weapon_only_fingerprint`]) when `Some`;
/// otherwise returns `None` — no evidence at all, the case elsewhere in this
/// codebase reported as `ROLE_UNOBSERVED`. Whichever fingerprint is produced
/// is then matched against `candidates` and has its match fields filled in.
#[must_use]
pub fn compute_and_match(
    kill_items: Option<&[KillItemSource]>,
    main_hand_item_id: Option<&str>,
    classifier: &RoleClassifier,
    candidates: &[BuildCandidate],
) -> Option<ComputedFingerprint> {
    let full = kill_items.and_then(|items| compute_full_fingerprint(items, classifier));
    let mut fingerprint = match full {
        Some(fingerprint) => fingerprint,
        None => main_hand_item_id.map(|id| compute_weapon_only_fingerprint(id, classifier))?,
    };

    let (matched_build_id, matched_build_loadout, match_status) =
        match_against_catalog(&fingerprint.slots, candidates);
    fingerprint.matched_build_id = matched_build_id;
    fingerprint.matched_build_loadout = matched_build_loadout;
    fingerprint.match_status = match_status;
    Some(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(upstream_slot: &str, item_type_id: &str) -> KillItemSource {
        KillItemSource {
            upstream_slot: upstream_slot.to_string(),
            item_type_id: item_type_id.to_string(),
        }
    }

    fn candidate(build_id: i64, loadout: &str, slots: &[(&str, &str)]) -> BuildCandidate {
        BuildCandidate {
            build_id,
            loadout: loadout.to_string(),
            slots: slots
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn every_upstream_slot_key_maps_to_its_build_side_key() {
        let table = [
            ("MainHand", "weapon"),
            ("OffHand", "off_hand"),
            ("Head", "head"),
            ("Armor", "armor"),
            ("Shoes", "shoes"),
            ("Cape", "cape"),
            ("Bag", "bag"),
            ("Potion", "potion"),
            ("Food", "food"),
            ("Mount", "mount"),
        ];
        for (upstream, build_side) in table {
            assert_eq!(
                map_upstream_slot(upstream),
                Some(build_side),
                "wrong mapping for {upstream}"
            );
        }
    }

    #[test]
    fn an_unrecognized_upstream_slot_is_silently_dropped() {
        let items = [
            item("MainHand", "T8_2H_HOLYSTAFF"),
            item("SomeWeirdSlot", "T8_JUNK"),
        ];
        let fp = compute_full_fingerprint(&items, &RoleClassifier::default()).unwrap();
        assert_eq!(fp.slots.len(), 1);
        assert!(fp.slots.contains_key("weapon"));
        assert!(!fp.fingerprint.contains("JUNK"));
    }

    #[test]
    fn full_fingerprint_is_none_without_a_main_hand_item() {
        let items = [
            item("Head", "T8_HEAD_PLATE_SET1"),
            item("Armor", "T8_ARMOR_PLATE_SET1"),
        ];
        assert!(compute_full_fingerprint(&items, &RoleClassifier::default()).is_none());
    }

    #[test]
    fn full_fingerprint_is_sorted_and_classifies_the_weapon() {
        let items = [
            item("Head", "T8_HEAD_PLATE_SET1@2"),
            item("MainHand", "T8_2H_HOLYSTAFF_MORGANA@3"),
            item("Armor", "T8_ARMOR_PLATE_SET1"),
        ];
        let fp = compute_full_fingerprint(&items, &RoleClassifier::default()).unwrap();

        assert_eq!(fp.mode, FingerprintMode::Full);
        assert_eq!(fp.main_hand_base_item_id, "2H_HOLYSTAFF_MORGANA");
        assert_eq!(fp.primary_role.as_deref(), Some("healer"));
        assert_eq!(
            fp.fingerprint,
            "armor:ARMOR_PLATE_SET1|head:HEAD_PLATE_SET1|weapon:2H_HOLYSTAFF_MORGANA"
        );
        assert_eq!(fp.slots.len(), 3);
        assert_eq!(fp.matched_build_id, None);
        assert_eq!(fp.match_status, MatchStatus::Unmatched);
    }

    #[test]
    fn weapon_only_fingerprint_has_a_single_slot_and_the_right_mode() {
        let fp = compute_weapon_only_fingerprint("T4_MAIN_MACE@1", &RoleClassifier::default());

        assert_eq!(fp.mode, FingerprintMode::WeaponOnly);
        assert_eq!(fp.main_hand_base_item_id, "MAIN_MACE");
        assert_eq!(fp.primary_role.as_deref(), Some("tank"));
        assert_eq!(fp.fingerprint, "weapon:MAIN_MACE");
        assert_eq!(fp.slots.len(), 1);
        assert_eq!(
            fp.slots.get("weapon").map(String::as_str),
            Some("MAIN_MACE")
        );
    }

    #[test]
    fn matches_the_candidate_with_the_largest_fully_agreeing_overlap() {
        let observed = BTreeMap::from([
            ("weapon".to_string(), "WEAPON_A".to_string()),
            ("head".to_string(), "HEAD_A".to_string()),
            ("armor".to_string(), "ARMOR_A".to_string()),
        ]);
        let candidates = [
            candidate(
                1,
                "main",
                &[
                    ("weapon", "WEAPON_A"),
                    ("head", "HEAD_A"),
                    ("armor", "ARMOR_A"),
                ],
            ),
            candidate(2, "main", &[("weapon", "WEAPON_A")]),
        ];

        let (build_id, loadout, status) = match_against_catalog(&observed, &candidates);
        assert_eq!(build_id, Some(1));
        assert_eq!(loadout.as_deref(), Some("main"));
        assert_eq!(status, MatchStatus::Matched);
    }

    #[test]
    fn a_candidate_disagreeing_on_one_shared_slot_is_disqualified() {
        let observed = BTreeMap::from([
            ("weapon".to_string(), "WEAPON_A".to_string()),
            ("head".to_string(), "HEAD_A".to_string()),
        ]);
        let candidates = [
            // Bigger overlap, but disagrees on head -> disqualified entirely.
            candidate(1, "main", &[("weapon", "WEAPON_A"), ("head", "HEAD_B")]),
            // Smaller overlap, fully agrees -> wins by elimination.
            candidate(2, "main", &[("weapon", "WEAPON_A")]),
        ];

        let (build_id, loadout, status) = match_against_catalog(&observed, &candidates);
        assert_eq!(build_id, Some(2));
        assert_eq!(loadout.as_deref(), Some("main"));
        assert_eq!(status, MatchStatus::Matched);
    }

    #[test]
    fn unmatched_when_every_overlapping_candidate_disagrees() {
        let observed = BTreeMap::from([("weapon".to_string(), "WEAPON_A".to_string())]);
        let candidates = [candidate(1, "main", &[("weapon", "WEAPON_B")])];

        let (build_id, loadout, status) = match_against_catalog(&observed, &candidates);
        assert_eq!(build_id, None);
        assert_eq!(loadout, None);
        assert_eq!(status, MatchStatus::Unmatched);
    }

    #[test]
    fn tied_top_scoring_candidates_are_ambiguous() {
        let observed = BTreeMap::from([("weapon".to_string(), "WEAPON_A".to_string())]);
        let candidates = [
            candidate(1, "main", &[("weapon", "WEAPON_A")]),
            candidate(1, "swap", &[("weapon", "WEAPON_A")]),
            candidate(2, "main", &[("weapon", "WEAPON_A")]),
        ];

        let (build_id, loadout, status) = match_against_catalog(&observed, &candidates);
        assert_eq!(build_id, None);
        assert_eq!(loadout, None);
        assert_eq!(status, MatchStatus::Ambiguous);
    }

    #[test]
    fn unmatched_when_no_candidate_shares_any_slot() {
        let observed = BTreeMap::from([("weapon".to_string(), "WEAPON_A".to_string())]);
        let candidates = [candidate(1, "main", &[("armor", "ARMOR_A")])];

        let (build_id, loadout, status) = match_against_catalog(&observed, &candidates);
        assert_eq!(build_id, None);
        assert_eq!(loadout, None);
        assert_eq!(status, MatchStatus::Unmatched);
    }

    #[test]
    fn compute_and_match_prefers_full_equipment_over_weapon_only() {
        let items = [item("MainHand", "T8_2H_HOLYSTAFF_MORGANA@3")];
        let candidates = [candidate(1, "main", &[("weapon", "2H_HOLYSTAFF_MORGANA")])];

        let fp = compute_and_match(
            Some(&items),
            Some("T8_2H_BOW"),
            &RoleClassifier::default(),
            &candidates,
        )
        .unwrap();

        assert_eq!(fp.mode, FingerprintMode::Full);
        assert_eq!(fp.main_hand_base_item_id, "2H_HOLYSTAFF_MORGANA");
        assert_eq!(fp.matched_build_id, Some(1));
        assert_eq!(fp.match_status, MatchStatus::Matched);
    }

    #[test]
    fn compute_and_match_falls_back_to_weapon_only_when_kill_items_is_none() {
        let candidates = [candidate(1, "main", &[("weapon", "MAIN_MACE")])];

        let fp = compute_and_match(
            None,
            Some("T4_MAIN_MACE@1"),
            &RoleClassifier::default(),
            &candidates,
        )
        .unwrap();

        assert_eq!(fp.mode, FingerprintMode::WeaponOnly);
        assert_eq!(fp.main_hand_base_item_id, "MAIN_MACE");
        assert_eq!(fp.matched_build_id, Some(1));
    }

    #[test]
    fn compute_and_match_falls_back_to_weapon_only_when_kill_items_yield_no_fingerprint() {
        // No MainHand in the kill items, so `compute_full_fingerprint` returns
        // `None` and the weapon-only fallback must be used instead.
        let items = [item("Head", "T8_HEAD_PLATE_SET1")];
        let candidates = [candidate(1, "main", &[("weapon", "MAIN_MACE")])];

        let fp = compute_and_match(
            Some(&items),
            Some("T4_MAIN_MACE@1"),
            &RoleClassifier::default(),
            &candidates,
        )
        .unwrap();

        assert_eq!(fp.mode, FingerprintMode::WeaponOnly);
        assert_eq!(fp.main_hand_base_item_id, "MAIN_MACE");
    }

    #[test]
    fn compute_and_match_is_none_with_no_evidence_at_all() {
        let candidates = [candidate(1, "main", &[("weapon", "MAIN_MACE")])];
        assert!(compute_and_match(None, None, &RoleClassifier::default(), &candidates).is_none());
    }
}
