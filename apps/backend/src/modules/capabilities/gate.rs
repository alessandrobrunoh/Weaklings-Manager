//! The tenant-kind gate for API prefixes.
//!
//! Feature flags are still enforced by the legacy table in `tenant.rs`. This
//! gate adds the kind rule the catalogue owns: a guild-only module is refused
//! for an alliance tenant. It runs in one of two modes, chosen by
//! `MODULE_KIND_ENFORCEMENT`:
//!
//! * `log` (default): the request goes through and a `would_block` count is
//!   recorded, so operators can see which callers would break before the flip;
//! * `enforce`: the request is refused with `403 module_unavailable`.

use std::sync::atomic::{AtomicU64, Ordering};

use super::catalogue;
use crate::errors::AppError;

/// What to do with a request whose tenant kind the module does not support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    /// Count and log, let the request through.
    Log,
    /// Refuse with `403 module_unavailable`.
    Enforce,
}

impl Enforcement {
    /// Parses `MODULE_KIND_ENFORCEMENT`. Anything other than `enforce` is `log`,
    /// so a typo never turns enforcement on by accident.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        if raw.trim().eq_ignore_ascii_case("enforce") {
            Self::Enforce
        } else {
            Self::Log
        }
    }
}

static WOULD_BLOCK: AtomicU64 = AtomicU64::new(0);

/// Requests that a `log`-mode gate would have refused, since process start.
#[must_use]
#[cfg_attr(
    not(test),
    allow(dead_code, reason = "read by the enforcement flip check (ops gate O2)")
)]
pub fn would_block_total() -> u64 {
    WOULD_BLOCK.load(Ordering::Relaxed)
}

/// Applies the kind rule to `path` for a tenant of `kind`.
///
/// # Errors
///
/// Returns [`AppError::ModuleUnavailable`] for an unsupported kind in `enforce` mode.
pub fn kind_gate(path: &str, kind: &str, mode: Enforcement) -> Result<(), AppError> {
    let path = path.trim_end_matches('/');
    // Bot routes and the OpenAPI document are never gated, whatever the catalogue says.
    if path.starts_with("/api/bot/") || path == "/api/openapi.json" {
        return Ok(());
    }
    let Some(module) = catalogue::module_for_path(path) else {
        return Ok(());
    };
    if module.supports_kind(kind) {
        return Ok(());
    }
    match mode {
        Enforcement::Enforce => Err(AppError::ModuleUnavailable {
            module: module.key.to_owned(),
            reason_code: "kind_unsupported".to_owned(),
        }),
        Enforcement::Log => {
            WOULD_BLOCK.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                path,
                kind,
                module = module.key,
                would_block = true,
                "request would be refused: module is not offered to this tenant kind"
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_word_enforce_turns_enforcement_on() {
        assert_eq!(Enforcement::parse("enforce"), Enforcement::Enforce);
        assert_eq!(Enforcement::parse(" ENFORCE "), Enforcement::Enforce);
        assert_eq!(Enforcement::parse("log"), Enforcement::Log);
        assert_eq!(Enforcement::parse(""), Enforcement::Log);
        assert_eq!(Enforcement::parse("enforced"), Enforcement::Log);
    }

    #[test]
    fn log_mode_lets_an_alliance_warns_request_through_and_counts_it() {
        let before = would_block_total();
        let result = kind_gate("/api/warns", "alliance", Enforcement::Log);
        assert!(result.is_ok(), "log mode must not refuse");
        assert!(would_block_total() > before, "would_block must increase");
    }

    #[test]
    fn enforce_mode_refuses_an_alliance_warns_request_with_module_unavailable() {
        let err = kind_gate("/api/warns/12", "alliance", Enforcement::Enforce)
            .expect_err("enforce refuses guild-only modules for alliances");
        match err {
            AppError::ModuleUnavailable {
                module,
                reason_code,
            } => {
                assert_eq!(module, "warns");
                assert_eq!(reason_code, "kind_unsupported");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn guild_requests_and_offered_modules_are_never_refused() {
        assert!(kind_gate("/api/warns", "guild", Enforcement::Enforce).is_ok());
        assert!(kind_gate("/api/events/1", "alliance", Enforcement::Enforce).is_ok());
        assert!(kind_gate("/api/bank/balance", "alliance", Enforcement::Enforce).is_ok());
    }

    #[test]
    fn bot_routes_unknown_prefixes_and_the_openapi_document_are_never_refused() {
        for path in [
            "/api/bot/outbox/claim",
            "/api/openapi.json",
            "/api/future/route",
        ] {
            assert!(
                kind_gate(path, "alliance", Enforcement::Enforce).is_ok(),
                "{path} must stay open"
            );
        }
    }
}
