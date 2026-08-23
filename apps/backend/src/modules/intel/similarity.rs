//! Pure, DB-free comp-similarity maths.
//!
//! This is the numeric heart of Intel: every screen that ranks an enemy
//! composition against another, or against one of our comps, ultimately calls
//! [`similarity`]. It is a direct port of the reference implementation and the
//! constants below are **load-bearing** — changing a weight silently skews
//! every Intel screen rather than failing loudly, which is why this module is
//! kept free of database access and covered by hand-computed fixtures.

use std::collections::BTreeMap;

/// Role vector order. The index of each key is load-bearing: [`cosine`] pairs
/// the two vectors positionally, so reordering this array changes every score.
pub const ROLE_KEYS: [&str; 6] = [
    "healer",
    "tank",
    "dps",
    "support",
    "brawler",
    "battle_mount",
];

/// Weight of the role cosine in the blended score.
const ROLE_WEIGHT: f64 = 0.55;
/// Weight of the weapon cosine in the blended score.
const WEAPON_WEIGHT: f64 = 0.45;
/// Maximum share of the score that a roster-size mismatch can remove.
const SIZE_PENALTY: f64 = 0.35;

/// A composition reduced to the two histograms similarity operates on.
///
/// `BTreeMap` rather than `HashMap` is deliberate: [`fingerprint_of`] needs a
/// deterministic, sorted iteration order, and getting it from the container
/// removes a whole class of "fingerprint changed but comp did not" bugs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompProfile {
    /// Count of players per role. Keys are [`ROLE_KEYS`] values.
    pub roles: BTreeMap<String, i64>,
    /// Count of players per main-hand weapon item id.
    pub weapons: BTreeMap<String, i64>,
}

impl CompProfile {
    /// Roster size, defined as the sum of the **role** histogram.
    ///
    /// Deliberately derived rather than stored: a cached size that drifts out
    /// of step with `roles` would corrupt the size penalty invisibly. The
    /// weapon histogram is not used here because its coverage is partial (only
    /// players appearing in the kill feed contribute a weapon).
    #[must_use]
    pub fn size(&self) -> i64 {
        self.roles.values().sum()
    }

    /// Whether this profile carries no role data at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.size() == 0
    }

    /// Adds one player with the given role and optional weapon.
    pub fn push_player(&mut self, role: &str, weapon: Option<&str>) {
        *self.roles.entry(role.to_string()).or_insert(0) += 1;
        if let Some(weapon) = weapon {
            *self.weapons.entry(weapon.to_string()).or_insert(0) += 1;
        }
    }
}

/// Cosine similarity of two equal-length vectors, in `0.0..=1.0`.
///
/// Returns `0.0` when either vector has zero magnitude, matching the reference
/// implementation: an all-zero histogram is treated as "no information", not
/// as a division-by-zero error.
#[must_use]
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Blended similarity of two comps, as an integer percentage in `0..=100`.
///
/// Roles carry 55% of the score and weapons 45%; the result is then scaled down
/// by up to 35% in proportion to how far apart the two roster sizes are, so a
/// 5-player gank squad does not read as identical to a 40-player ZvZ ball that
/// happens to share the same role ratios.
///
/// A profile with no weapon data still scores on roles alone — the weapon
/// cosine simply contributes zero. Callers showing this number to a user should
/// pair it with the weapon sample size, because partial kill-feed coverage
/// lowers the weapon term without that being a real difference between comps.
#[must_use]
pub fn similarity(a: &CompProfile, b: &CompProfile) -> i32 {
    let role_a: Vec<f64> = ROLE_KEYS
        .iter()
        .map(|k| a.roles.get(*k).copied().unwrap_or(0) as f64)
        .collect();
    let role_b: Vec<f64> = ROLE_KEYS
        .iter()
        .map(|k| b.roles.get(*k).copied().unwrap_or(0) as f64)
        .collect();

    // Weapon vectors are indexed over the union of both weapon sets, so a
    // weapon present in only one comp contributes a zero on the other side.
    let mut names: Vec<&String> = a.weapons.keys().chain(b.weapons.keys()).collect();
    names.sort_unstable();
    names.dedup();
    let weapon_a: Vec<f64> = names
        .iter()
        .map(|n| a.weapons.get(*n).copied().unwrap_or(0) as f64)
        .collect();
    let weapon_b: Vec<f64> = names
        .iter()
        .map(|n| b.weapons.get(*n).copied().unwrap_or(0) as f64)
        .collect();

    let blended = cosine(&role_a, &role_b) * ROLE_WEIGHT + cosine(&weapon_a, &weapon_b) * WEAPON_WEIGHT;

    let size_a = a.size();
    let size_b = b.size();
    let size_factor = if size_a == 0 || size_b == 0 {
        1.0
    } else {
        let spread = (size_a - size_b).abs() as f64 / size_a.max(size_b) as f64;
        1.0 - SIZE_PENALTY * spread
    };

    (blended * size_factor * 100.0).round() as i32
}

/// Canonical, order-independent key used to deduplicate scouted comps.
///
/// Shape is `"role:n,role:n|weapon:n,weapon:n"` with both halves sorted and
/// zero-count roles omitted. Two scouting runs over the same enemy ball
/// therefore produce the same string regardless of the order players appeared
/// in the kill feed.
///
/// Sorting is byte order rather than a locale collation. Role names and Albion
/// item ids are ASCII, so this matches the reference implementation's
/// `localeCompare` for every input that can actually occur here.
#[must_use]
pub fn fingerprint_of(roles: &BTreeMap<String, i64>, weapons: &BTreeMap<String, i64>) -> String {
    let role_part = roles
        .iter()
        .filter(|(_, count)| **count > 0)
        .map(|(name, count)| format!("{name}:{count}"))
        .collect::<Vec<_>>()
        .join(",");
    let weapon_part = weapons
        .iter()
        .map(|(name, count)| format!("{name}:{count}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{role_part}|{weapon_part}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a profile from `(role, count)` and `(weapon, count)` pairs.
    fn profile(roles: &[(&str, i64)], weapons: &[(&str, i64)]) -> CompProfile {
        CompProfile {
            roles: roles.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
            weapons: weapons.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        }
    }

    #[test]
    fn identical_comps_score_100() {
        let a = profile(&[("healer", 1), ("tank", 1)], &[("A", 1), ("B", 1)]);
        assert_eq!(similarity(&a, &a), 100);
    }

    #[test]
    fn fully_disjoint_comps_score_0() {
        let a = profile(&[("healer", 2)], &[("A", 2)]);
        let b = profile(&[("tank", 2)], &[("B", 2)]);
        assert_eq!(similarity(&a, &b), 0);
    }

    /// Same shape, different scale: cosine is 1.0 on both axes, so the whole
    /// deduction comes from the size penalty.
    /// 1 - 0.35 * (2/3) = 0.766666… -> 77.
    #[test]
    fn size_mismatch_applies_the_penalty() {
        let a = profile(&[("dps", 1)], &[("A", 1)]);
        let b = profile(&[("dps", 3)], &[("A", 3)]);
        assert_eq!(similarity(&a, &b), 77);
    }

    /// Roles match perfectly, weapons not at all: 1.0*0.55 + 0.0*0.45 = 0.55.
    #[test]
    fn role_and_weapon_weights_are_55_45() {
        let a = profile(&[("dps", 2)], &[("A", 2)]);
        let b = profile(&[("dps", 2)], &[("B", 2)]);
        assert_eq!(similarity(&a, &b), 55);
    }

    /// A comp with no weapon data at all still scores on roles alone.
    #[test]
    fn missing_weapon_data_scores_on_roles_only() {
        let a = profile(&[("dps", 2)], &[]);
        let b = profile(&[("dps", 2)], &[]);
        assert_eq!(similarity(&a, &b), 55);
    }

    #[test]
    fn empty_profiles_score_0() {
        let empty = CompProfile::default();
        assert_eq!(similarity(&empty, &empty), 0);
        assert!(empty.is_empty());
    }

    #[test]
    fn size_is_derived_from_roles_not_weapons() {
        let mut p = CompProfile::default();
        p.push_player("dps", Some("A"));
        p.push_player("dps", None);
        p.push_player("healer", Some("B"));
        assert_eq!(p.size(), 3);
        assert_eq!(p.weapons.values().sum::<i64>(), 2);
    }

    #[test]
    fn similarity_is_symmetric() {
        let a = profile(&[("dps", 3), ("healer", 1)], &[("A", 3), ("B", 1)]);
        let b = profile(&[("dps", 2), ("tank", 2)], &[("A", 2), ("C", 2)]);
        assert_eq!(similarity(&a, &b), similarity(&b, &a));
    }

    #[test]
    fn similarity_is_bounded_0_100() {
        let a = profile(&[("dps", 40)], &[("A", 40)]);
        let b = profile(&[("healer", 1)], &[("B", 1)]);
        let score = similarity(&a, &b);
        assert!((0..=100).contains(&score), "score out of range: {score}");
    }

    #[test]
    fn fingerprint_sorts_and_drops_zero_roles() {
        let roles: BTreeMap<String, i64> = [("healer", 1), ("dps", 2), ("tank", 0)]
            .iter()
            .map(|(k, v)| ((*k).to_string(), *v))
            .collect();
        let weapons: BTreeMap<String, i64> = [("T8_MAIN_HOLYSTAFF", 2), ("T8_2H_BOW", 1)]
            .iter()
            .map(|(k, v)| ((*k).to_string(), *v))
            .collect();
        assert_eq!(
            fingerprint_of(&roles, &weapons),
            "dps:2,healer:1|T8_2H_BOW:1,T8_MAIN_HOLYSTAFF:2"
        );
    }

    /// Insertion order must not change the fingerprint — this is the whole
    /// point of the canonical form.
    #[test]
    fn fingerprint_is_insertion_order_independent() {
        let mut a = CompProfile::default();
        a.push_player("dps", Some("B"));
        a.push_player("healer", Some("A"));
        let mut b = CompProfile::default();
        b.push_player("healer", Some("A"));
        b.push_player("dps", Some("B"));
        assert_eq!(
            fingerprint_of(&a.roles, &a.weapons),
            fingerprint_of(&b.roles, &b.weapons)
        );
    }

    #[test]
    fn cosine_of_zero_vector_is_zero() {
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine(&[1.0, 2.0], &[0.0, 0.0]), 0.0);
    }

    #[test]
    fn role_keys_cover_every_build_role() {
        use crate::modules::comps::status::BuildRole;
        use std::str::FromStr;
        for key in ROLE_KEYS {
            assert!(BuildRole::from_str(key).is_ok(), "unknown role key: {key}");
        }
        assert_eq!(ROLE_KEYS.len(), 6);
    }
}
