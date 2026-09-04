//! Glob matching for Destiny Board item patterns.
//!
//! `achievements.json` expresses which items a Destiny Board node grants Item Power to as glob
//! patterns over the item's unique name: `T?_2H_POLEHAMMER` for one weapon, `T?_ARMOR_PLATE*` for
//! a whole family. `?` stands for exactly one character (always the tier digit in practice) and
//! `*` for zero or more.
//!
//! The matcher is iterative rather than recursive so a pattern full of `*` cannot exhaust the
//! stack, and it is deliberately not a regex: the generator asserts every pattern is made only of
//! `[A-Z0-9_?*]`, which this handles exactly and total.

/// Returns whether `unique_name` matches the Destiny Board `pattern`.
///
/// Both sides are compared byte-for-byte and are upper-case ASCII in the dumps, so no case folding
/// is applied. The match is anchored at both ends.
///
/// # Examples
///
/// ```ignore
/// assert!(matches("T?_2H_POLEHAMMER", "T8_2H_POLEHAMMER"));
/// assert!(!matches("T?_2H_POLEHAMMER", "T8_2H_POLEHAMMER_AVALON"));
/// assert!(matches("T?_ARMOR_PLATE*", "T8_ARMOR_PLATE_SET1"));
/// ```
#[must_use]
pub fn matches(pattern: &str, unique_name: &str) -> bool {
    let pattern = pattern.as_bytes();
    let name = unique_name.as_bytes();
    let (mut p, mut n) = (0usize, 0usize);
    // Where the last `*` was seen, and how much of the name it had consumed at that point.
    let mut star: Option<usize> = None;
    let mut consumed = 0usize;

    while n < name.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            consumed = n;
            p += 1;
        } else if let Some(position) = star {
            // Backtrack: let the `*` swallow one more byte and retry from just after it.
            p = position + 1;
            consumed += 1;
            n = consumed;
        } else {
            return false;
        }
    }

    pattern[p..].iter().all(|byte| *byte == b'*')
}

/// Rebuilds the unique name a Destiny Board pattern is written against.
///
/// Patterns never carry an enchantment suffix — `T?_2H_POLEHAMMER`, never `T?_2H_POLEHAMMER@2` —
/// so the name to match is the tier plus the base identifier and nothing else.
#[must_use]
pub fn unique_name(tier: u8, base: &str) -> String {
    format!("T{tier}_{base}")
}

#[cfg(test)]
mod glob_tests {
    use super::{matches, unique_name};

    #[test]
    fn tier_wildcard_matches_every_tier() {
        for tier in 4..=8 {
            assert!(matches("T?_2H_POLEHAMMER", &unique_name(tier, "2H_POLEHAMMER")));
        }
    }

    #[test]
    fn an_exact_pattern_does_not_match_a_longer_name() {
        assert!(!matches("T?_2H_POLEHAMMER", "T8_2H_POLEHAMMER_AVALON"));
        assert!(!matches("T?_2H_HAMMER", "T8_2H_HAMMER_UNDEAD"));
    }

    #[test]
    fn a_trailing_star_matches_the_whole_family() {
        assert!(matches("T?_2H_HAMMER*", "T8_2H_HAMMER"));
        assert!(matches("T?_2H_HAMMER*", "T8_2H_HAMMER_UNDEAD"));
        assert!(matches("T?_ARMOR_PLATE*", "T4_ARMOR_PLATE_SET3"));
    }

    #[test]
    fn a_question_mark_consumes_exactly_one_byte() {
        assert!(matches("T?_BAG", "T4_BAG"));
        assert!(!matches("T?_BAG", "T_BAG"));
        assert!(!matches("T?_BAG", "T44_BAG"));
    }

    #[test]
    fn the_family_pattern_does_not_leak_across_families() {
        assert!(!matches("T?_2H_HAMMER*", "T8_2H_POLEHAMMER"));
        assert!(!matches("T?_ARMOR_PLATE*", "T8_ARMOR_LEATHER_SET1"));
    }

    #[test]
    fn backtracking_terminates_on_a_star_heavy_pattern() {
        assert!(matches("*_*_*", "T8_ARMOR_PLATE_SET1"));
        assert!(!matches("*_*_*X", "T8_ARMOR_PLATE_SET1"));
        assert!(matches("********", "T8_MAIN_SWORD"));
    }

    #[test]
    fn an_empty_name_matches_only_stars() {
        assert!(matches("*", ""));
        assert!(matches("", ""));
        assert!(!matches("T?", ""));
    }
}
