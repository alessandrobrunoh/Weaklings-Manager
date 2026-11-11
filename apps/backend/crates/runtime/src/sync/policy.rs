//! Which sync kinds run on the engine, and the defaults that depend on the
//! kind of job.
//!
//! Rollback lever (R20): `SYNC_ENGINE_KINDS` lists the kinds that run on the
//! engine (empty = every kind stays on its legacy path), and
//! `SYNC_KINDS_DISABLED` pauses a kind without a code change. A disabled kind
//! stops producing jobs and its pending jobs are not claimed.

use std::collections::BTreeSet;

/// Comma list of kinds that run on the engine.
pub const ENGINE_KINDS_ENV: &str = "SYNC_ENGINE_KINDS";
/// Comma list of kinds to pause, overriding [`ENGINE_KINDS_ENV`].
pub const KINDS_DISABLED_ENV: &str = "SYNC_KINDS_DISABLED";

/// Parsed kill switches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSettings {
    enabled: BTreeSet<String>,
    disabled: BTreeSet<String>,
}

impl SyncSettings {
    /// Parses both comma lists; blanks and surrounding spaces are ignored.
    #[must_use]
    pub fn parse(enabled: &str, disabled: &str) -> Self {
        Self {
            enabled: split_list(enabled),
            disabled: split_list(disabled),
        }
    }

    /// Reads [`ENGINE_KINDS_ENV`] and [`KINDS_DISABLED_ENV`].
    #[must_use]
    pub fn from_env() -> Self {
        Self::parse(
            &std::env::var(ENGINE_KINDS_ENV).unwrap_or_default(),
            &std::env::var(KINDS_DISABLED_ENV).unwrap_or_default(),
        )
    }

    /// Whether `kind` runs on the engine right now.
    #[must_use]
    pub fn is_active(&self, kind: &str) -> bool {
        self.enabled.contains(kind) && !self.disabled.contains(kind)
    }

    /// Whether any kind runs on the engine (the loops idle otherwise).
    #[must_use]
    pub fn any_active(&self) -> bool {
        self.enabled.iter().any(|kind| self.is_active(kind))
    }

    /// The registered kinds that are active, sorted.
    #[must_use]
    pub fn active_kinds<'a>(&self, registered: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        let mut kinds: Vec<String> = registered
            .into_iter()
            .filter(|kind| self.is_active(kind))
            .map(str::to_owned)
            .collect();
        kinds.sort();
        kinds
    }
}

fn split_list(raw: &str) -> BTreeSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Claim priority of a job by its operation (lower runs first): commands 1,
/// state 3, effects 5, scans (backfill) 8.
#[must_use]
pub fn priority_for(op: &str) -> i16 {
    match op {
        "command" => 1,
        "effect" => 5,
        "scan" => 8,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_settings_leave_every_kind_on_the_legacy_path() {
        let settings = SyncSettings::parse("", "  ,");
        assert!(!settings.any_active());
        assert!(!settings.is_active("event"));
        assert!(settings.active_kinds(["event", "build"]).is_empty());
    }

    #[test]
    fn enabled_kinds_run_and_disabled_kinds_are_paused_without_a_deploy() {
        let settings = SyncSettings::parse(" build, event ,", "event");
        assert!(settings.any_active());
        assert!(settings.is_active("build"));
        assert!(!settings.is_active("event"), "disable wins over enable");
        assert!(!settings.is_active("comp"));
        assert_eq!(
            settings.active_kinds(["event", "build", "comp"]),
            vec!["build".to_owned()]
        );
    }

    #[test]
    fn a_disabled_only_kind_is_not_active() {
        let settings = SyncSettings::parse("", "event");
        assert!(!settings.any_active());
    }

    #[test]
    fn commands_claim_first_and_backfill_scans_last() {
        assert!(priority_for("command") < priority_for("upsert"));
        assert!(priority_for("upsert") < priority_for("effect"));
        assert!(priority_for("effect") < priority_for("scan"));
    }
}
