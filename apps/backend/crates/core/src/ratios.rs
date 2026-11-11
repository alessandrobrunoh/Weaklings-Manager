//! Ratio helpers shared by event and intel analytics.

/// Computes a percentage and safely handles empty denominators.
pub fn ratio_percent(part: i64, total: i64) -> f64 {
    if total == 0 {
        return 0.0;
    }

    (part as f64 / total as f64) * 100.0
}

/// Computes K/D while avoiding division by zero.
pub fn kill_death_ratio(kills: i64, deaths: i64) -> f64 {
    if deaths == 0 {
        return kills as f64;
    }

    kills as f64 / deaths as f64
}
