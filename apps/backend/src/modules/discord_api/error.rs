//! Typed Discord REST failures and the single status-to-error mapping.

use std::time::Duration;

use serde::Deserialize;

use crate::errors::AppError;

/// Discord JSON error code "Unknown Member": the server is visible and the user is not in it.
pub const UNKNOWN_MEMBER: u32 = 10007;

/// Discord JSON error code "Unknown Guild": the bot is not in that server (or it is gone).
pub const UNKNOWN_GUILD: u32 = 10004;

/// Wait used for a `429` that carries no readable `Retry-After`.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(1);

/// Upper bound on any `Retry-After` the backend honours.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(3600);

/// Longest response body kept in an error message.
const MESSAGE_LIMIT: usize = 300;

/// A failed Discord REST call.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DiscordError {
    /// No usable bot token is configured, so the call was never made.
    #[error("Discord bot token is not configured")]
    NotConfigured,
    /// `404` with code 10007: the server is visible and the user is not a member.
    #[error("member is not in the Discord server")]
    MemberNotFound,
    /// `404` with code 10004: the bot cannot see the server.
    #[error("the bot is not in this Discord server (unknown guild)")]
    GuildNotFound,
    /// Any other `404`, for example an unknown role (10011) or a proxy page.
    #[error("Discord returned 404 (code {code:?})")]
    NotFound {
        /// Discord JSON error code, when the body had one.
        code: Option<u32>,
    },
    /// `403`: missing permission, missing intent, or role hierarchy.
    #[error("Discord refused the request (403): {message}")]
    Forbidden {
        /// Discord JSON error code, when the body had one.
        code: Option<u32>,
        /// Truncated response body.
        message: String,
    },
    /// `429`: wait `retry_after` before calling this guild again.
    #[error("Discord rate limit, retry after {retry_after:?}")]
    RateLimited {
        /// Delay from `Retry-After` (header, else body), capped at one hour.
        retry_after: Duration,
    },
    /// Any other non-2xx answer (5xx included).
    #[error("Discord returned status {status}: {message}")]
    Status {
        /// HTTP status code.
        status: u16,
        /// Discord JSON error code, when the body had one.
        code: Option<u32>,
        /// Truncated response body.
        message: String,
    },
    /// The request did not complete (connect, TLS, timeout).
    #[error("Discord request failed: {0}")]
    Transport(String),
    /// A 2xx answer whose body did not match the expected payload.
    #[error("Discord response was invalid: {0}")]
    InvalidPayload(String),
}

impl DiscordError {
    /// The member is confirmed absent from the server (code 10007, nothing else).
    #[must_use]
    pub fn is_missing_member(&self) -> bool {
        matches!(self, Self::MemberNotFound)
    }

    /// The thing a write wanted to remove is already gone (a 404 that is not "unknown guild"),
    /// so an idempotent revoke may treat it as success.
    #[must_use]
    pub fn is_already_gone(&self) -> bool {
        matches!(self, Self::MemberNotFound | Self::NotFound { .. })
    }

    /// A role DELETE that answered `404` in any form counts as "the role is not on the member",
    /// as the pre-refactor revoke paths treated it. This includes `10004`: a bot that left the
    /// server cannot remove the role, and the revocation must not stay pending forever.
    #[must_use]
    pub fn is_role_removed(&self) -> bool {
        matches!(
            self,
            Self::MemberNotFound | Self::GuildNotFound | Self::NotFound { .. }
        )
    }
}

/// Maps a non-2xx Discord answer to a [`DiscordError`].
///
/// `retry_after_header` is the raw `Retry-After` header value, if any; `body` is the response
/// body. Codes are read from the body only: a bare `404` never proves a member left.
#[must_use]
pub fn classify(status: u16, retry_after_header: Option<&str>, body: &str) -> DiscordError {
    let code = discord_error_code(body);
    match status {
        404 => match code {
            Some(UNKNOWN_MEMBER) => DiscordError::MemberNotFound,
            Some(UNKNOWN_GUILD) => DiscordError::GuildNotFound,
            _ => DiscordError::NotFound { code },
        },
        403 => DiscordError::Forbidden {
            code,
            message: truncate(body),
        },
        429 => DiscordError::RateLimited {
            retry_after: retry_after_header
                .and_then(parse_seconds)
                .or_else(|| retry_after_from_body(body))
                .unwrap_or(DEFAULT_RETRY_AFTER),
        },
        _ => DiscordError::Status {
            status,
            code,
            message: truncate(body),
        },
    }
}

/// Reads the `code` field of a Discord error body, if the body is one.
#[must_use]
pub fn discord_error_code(body: &str) -> Option<u32> {
    error_body(body).and_then(|parsed| parsed.code)
}

/// Converts a Discord failure into the upstream error the HTTP layer reports.
///
/// `context` names the failed operation (for example `"Discord roles request failed"`).
#[must_use]
pub fn upstream(context: &str, error: DiscordError) -> AppError {
    match error {
        DiscordError::NotConfigured => {
            AppError::UpstreamService("Discord bot token is not configured".to_string())
        }
        other => AppError::UpstreamService(format!("{context}: {other}")),
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    code: Option<u32>,
    #[serde(default)]
    retry_after: Option<f64>,
}

fn error_body(body: &str) -> Option<ErrorBody> {
    serde_json::from_str::<ErrorBody>(body).ok()
}

fn retry_after_from_body(body: &str) -> Option<Duration> {
    error_body(body)
        .and_then(|parsed| parsed.retry_after)
        .and_then(seconds_to_duration)
}

fn parse_seconds(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .and_then(seconds_to_duration)
}

fn seconds_to_duration(seconds: f64) -> Option<Duration> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(
        seconds.min(MAX_RETRY_AFTER.as_secs_f64()),
    ))
}

fn truncate(body: &str) -> String {
    body.chars().take(MESSAGE_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_member_404_is_the_only_confirmed_absence() {
        let body = r#"{"message": "Unknown Member", "code": 10007}"#;
        assert_eq!(classify(404, None, body), DiscordError::MemberNotFound);
        assert!(classify(404, None, body).is_missing_member());
    }

    #[test]
    fn unknown_guild_404_is_not_absence() {
        // The bot was removed from the server: every member lookup 404s with 10004.
        let body = r#"{"message": "Unknown Guild", "code": 10004}"#;
        assert_eq!(classify(404, None, body), DiscordError::GuildNotFound);
        assert!(!classify(404, None, body).is_missing_member());
    }

    #[test]
    fn a_404_without_a_readable_code_is_not_absence() {
        assert_eq!(
            classify(404, None, "<html>Not Found</html>"),
            DiscordError::NotFound { code: None }
        );
        assert_eq!(
            classify(404, None, r#"{"message": "Unknown Role", "code": 10011}"#),
            DiscordError::NotFound { code: Some(10011) }
        );
    }

    #[test]
    fn the_code_only_matters_on_a_404() {
        let body = r#"{"message": "Unknown Member", "code": 10007}"#;
        assert_eq!(
            classify(500, None, body),
            DiscordError::Status {
                status: 500,
                code: Some(UNKNOWN_MEMBER),
                message: body.to_string(),
            }
        );
    }

    #[test]
    fn forbidden_403_keeps_its_code_and_message() {
        let body = r#"{"message": "Missing Permissions", "code": 50013}"#;
        assert_eq!(
            classify(403, None, body),
            DiscordError::Forbidden {
                code: Some(50013),
                message: body.to_string(),
            }
        );
    }

    #[test]
    fn rate_limit_uses_the_retry_after_header() {
        assert_eq!(
            classify(429, Some("2.5"), r#"{"retry_after": 9}"#),
            DiscordError::RateLimited {
                retry_after: Duration::from_millis(2500)
            }
        );
    }

    #[test]
    fn rate_limit_falls_back_to_the_body_then_a_default() {
        assert_eq!(
            classify(429, None, r#"{"message": "rate", "retry_after": 0.5}"#),
            DiscordError::RateLimited {
                retry_after: Duration::from_millis(500)
            }
        );
        assert_eq!(
            classify(429, Some("not-a-number"), ""),
            DiscordError::RateLimited {
                retry_after: DEFAULT_RETRY_AFTER
            }
        );
    }

    #[test]
    fn retry_after_is_capped_and_negative_values_ignored() {
        assert_eq!(
            classify(429, Some("999999"), ""),
            DiscordError::RateLimited {
                retry_after: MAX_RETRY_AFTER
            }
        );
        assert_eq!(
            classify(429, Some("-3"), ""),
            DiscordError::RateLimited {
                retry_after: DEFAULT_RETRY_AFTER
            }
        );
    }

    #[test]
    fn server_errors_are_plain_status_failures() {
        assert_eq!(
            classify(503, None, "down"),
            DiscordError::Status {
                status: 503,
                code: None,
                message: "down".to_string(),
            }
        );
    }

    #[test]
    fn an_already_gone_target_is_a_404_except_unknown_guild() {
        assert!(DiscordError::MemberNotFound.is_already_gone());
        assert!(DiscordError::NotFound { code: Some(10011) }.is_already_gone());
        assert!(!DiscordError::GuildNotFound.is_already_gone());
        assert!(
            !DiscordError::RateLimited {
                retry_after: DEFAULT_RETRY_AFTER
            }
            .is_already_gone()
        );
    }

    #[test]
    fn a_role_delete_404_in_any_form_counts_as_removed() {
        assert!(DiscordError::MemberNotFound.is_role_removed());
        assert!(DiscordError::GuildNotFound.is_role_removed());
        assert!(DiscordError::NotFound { code: None }.is_role_removed());
        assert!(
            !DiscordError::Forbidden {
                code: Some(50013),
                message: String::new(),
            }
            .is_role_removed()
        );
        assert!(
            !DiscordError::RateLimited {
                retry_after: DEFAULT_RETRY_AFTER
            }
            .is_role_removed()
        );
    }

    #[test]
    fn discord_error_code_is_read_from_the_json_body() {
        assert_eq!(
            discord_error_code(r#"{"message": "Unknown Member", "code": 10007}"#),
            Some(10007)
        );
        assert_eq!(discord_error_code("<html>Not Found</html>"), None);
        assert_eq!(discord_error_code(""), None);
        assert_eq!(discord_error_code(r#"{"message": "no code"}"#), None);
    }

    #[test]
    fn upstream_names_the_missing_token_and_the_failed_operation() {
        assert!(matches!(
            upstream("Discord roles request failed", DiscordError::NotConfigured),
            AppError::UpstreamService(message) if message == "Discord bot token is not configured"
        ));
        assert!(matches!(
            upstream("Discord roles request failed", DiscordError::Transport("boom".into())),
            AppError::UpstreamService(message) if message.starts_with("Discord roles request failed: ")
        ));
    }
}
