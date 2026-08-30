//! Request/response DTOs for the warn register.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::WarnSeverity;

/// Body of `POST /api/warns`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct IssueWarnRequest {
    /// Target member.
    pub user_id: i64,
    /// Required non-empty reason.
    pub reason: String,
    /// Defaults to `warn`.
    pub severity: Option<WarnSeverity>,
    /// Optional XP multiplier to apply to the covering-season account.
    pub multiplier: Option<f64>,
    /// Optional RFC 3339 expiry for that multiplier.
    pub multiplier_expires_at: Option<String>,
}

/// One warn row, including revoked rows.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WarnView {
    /// Row id.
    pub id: i64,
    /// Target member.
    pub user_id: i64,
    /// Target member display name, when resolved.
    pub username: Option<String>,
    /// Issuer.
    pub issued_by_user_id: i64,
    /// Issuer display name, when resolved.
    pub issued_by_username: Option<String>,
    /// Reason text.
    pub reason: String,
    /// Severity tag.
    pub severity: WarnSeverity,
    /// Optional multiplier snapshotted on the warn.
    #[schema(value_type = Option<String>, example = "0.5")]
    pub multiplier: Option<Decimal>,
    /// Optional expiry, RFC 3339.
    pub multiplier_expires_at: Option<String>,
    /// Revocation time, RFC 3339.
    pub revoked_at: Option<String>,
    /// Who revoked.
    pub revoked_by: Option<i64>,
    /// Issue time, RFC 3339.
    pub created_at: String,
}

/// One escalation row.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WarnEscalationView {
    /// Row id.
    pub id: i64,
    /// Target member.
    pub user_id: i64,
    /// Target member display name, when resolved.
    pub username: Option<String>,
    /// Threshold at open time.
    pub threshold_at_time: i32,
    /// Active-warn count at open time.
    pub warn_count_at_time: i32,
    /// Open time, RFC 3339.
    pub opened_at: String,
    /// Ack time, RFC 3339.
    pub acknowledged_at: Option<String>,
    /// Who acknowledged.
    pub acknowledged_by: Option<i64>,
    /// Close reason if the row was closed without (or before) ack.
    pub closed_reason: Option<String>,
}

/// Query filters for `GET /api/warns`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct WarnFilters {
    /// Restrict to one member.
    pub user_id: Option<i64>,
    /// Restrict to one severity.
    pub severity: Option<WarnSeverity>,
    /// `true` = only revoked, `false` = only active, omitted = all (including revoked).
    pub revoked: Option<bool>,
    /// Case-insensitive substring match on reason.
    pub search: Option<String>,
    /// Sort column. Allowed: `created_at` (default), `severity`, `reason`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
}
