//! Level curve: cumulative XP required to reach a level.
//!
//! `threshold(n) = round(base * (n - 1).pow(exponent))` for `n >= 2`, and `0` for level 1.

/// Cumulative XP required to be at `level` (inclusive).
///
/// Level 1 is always 0. Levels above `max_level` are not used by callers; this function does not
/// clamp.
#[must_use]
pub fn threshold(level: i32, base: f64, exponent: f64) -> i64 {
    if level <= 1 {
        return 0;
    }
    let n = f64::from(level - 1);
    (base * n.powf(exponent)).round() as i64
}

/// Highest level whose threshold is `<= xp`, capped at `max_level` (minimum 1).
#[must_use]
pub fn level_for_xp(xp: i64, base: f64, exponent: f64, max_level: i32) -> i32 {
    let cap = max_level.max(1);
    let mut level = 1;
    for candidate in 2..=cap {
        if threshold(candidate, base, exponent) <= xp {
            level = candidate;
        } else {
            break;
        }
    }
    level
}

/// XP still needed to reach the next level. `0` when already at `max_level`.
#[must_use]
pub fn xp_to_next(xp: i64, level: i32, base: f64, exponent: f64, max_level: i32) -> i64 {
    if level >= max_level.max(1) {
        return 0;
    }
    (threshold(level + 1, base, exponent) - xp).max(0)
}

/// Applies `multiplier` and the stored fractional remainder.
///
/// Returns `(applied_integer_xp, new_remainder)` where `new_remainder` is in `[0, 1)`.
#[must_use]
pub fn apply_multiplier(base_amount: i64, multiplier: f64, remainder: f64) -> (i64, f64) {
    let raw = (base_amount as f64).mul_add(multiplier, remainder);
    if !raw.is_finite() {
        return (0, 0.0);
    }
    let applied = raw.floor() as i64;
    let new_remainder = raw - applied as f64;
    (applied, new_remainder.clamp(0.0, 0.999_999_999))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: f64 = 100.0;
    const EXP: f64 = 1.5;

    #[test]
    fn level_one_is_free() {
        assert_eq!(threshold(1, BASE, EXP), 0);
        assert_eq!(threshold(0, BASE, EXP), 0);
    }

    #[test]
    fn default_curve_matches_plan_examples() {
        assert_eq!(threshold(2, BASE, EXP), 100);
        assert_eq!(threshold(5, BASE, EXP), 800);
        assert_eq!(threshold(10, BASE, EXP), 2700);
        assert_eq!(threshold(20, BASE, EXP), 8282);
    }

    #[test]
    fn level_for_xp_steps_at_thresholds() {
        assert_eq!(level_for_xp(0, BASE, EXP, 50), 1);
        assert_eq!(level_for_xp(99, BASE, EXP, 50), 1);
        assert_eq!(level_for_xp(100, BASE, EXP, 50), 2);
        assert_eq!(level_for_xp(799, BASE, EXP, 50), 4);
        assert_eq!(level_for_xp(800, BASE, EXP, 50), 5);
    }

    #[test]
    fn max_level_caps_even_with_huge_xp() {
        assert_eq!(level_for_xp(i64::MAX, BASE, EXP, 3), 3);
    }

    #[test]
    fn xp_to_next_is_zero_at_cap() {
        let xp = threshold(3, BASE, EXP);
        assert_eq!(xp_to_next(xp, 3, BASE, EXP, 3), 0);
        assert_eq!(xp_to_next(0, 1, BASE, EXP, 50), 100);
    }

    #[test]
    fn half_multiplier_carries_remainder() {
        let (first, rem) = apply_multiplier(1, 0.5, 0.0);
        assert_eq!(first, 0);
        assert!((rem - 0.5).abs() < 1e-9);

        let (second, rem2) = apply_multiplier(1, 0.5, rem);
        assert_eq!(second, 1);
        assert!(rem2.abs() < 1e-9);
    }
}
