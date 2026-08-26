//! Request and response types for the admin module.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One role and the permissions currently granted to it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RolePermissionsView {
    /// Discord role id, the primary key of `roles`.
    pub role_id: String,
    /// Human-readable role name.
    pub role_name: String,
    /// Ordering weight; higher wins when a member holds several roles.
    pub priority: i32,
    /// Permission keys granted to this role.
    pub permissions: Vec<String>,
}

/// The whole authorization matrix, plus the full set of assignable keys.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PermissionMatrix {
    /// Every role known to the system, highest priority first.
    pub roles: Vec<RolePermissionsView>,
    /// Every permission the backend can gate on, so the UI can render the
    /// full grid rather than only what happens to be granted today.
    pub available_permissions: Vec<String>,
}

/// Request body to replace one role's permission set.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateRolePermissionsRequest {
    /// The complete set of permissions the role should end up with.
    ///
    /// This is a replacement, not a patch: sending the full set makes the
    /// outcome independent of what was there before, so two officers editing
    /// the same role cannot interleave into a state neither intended.
    pub permissions: Vec<String>,
}

/// The guild's Discord integration settings, as seen by the client.
///
/// Every field is nullable — an unset channel means "the code that would post there skips it",
/// same as the deployment env vars this table replaced.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct GuildSettingsView {
    /// Channel where the bot/poller announces new events.
    pub discord_events_channel_id: Option<String>,
    /// Channel where the bot/poller announces new battles.
    pub discord_battles_channel_id: Option<String>,
    /// Channel where call-to-arms events get their urgent announcement.
    pub discord_battles_cta_channel_id: Option<String>,
    /// Channel that receives a copy of every audit log entry.
    pub discord_audit_log_channel_id: Option<String>,
    /// Channel that receives transaction (bank ledger) activity.
    pub discord_transaction_spam_channel_id: Option<String>,
    /// Role pinged by event announcements, reminders, and start notices.
    pub discord_event_role_id: Option<String>,
}

impl GuildSettingsView {
    /// Builds a view from the singleton model row.
    #[must_use]
    pub fn from_model(model: super::entities::Model) -> Self {
        Self {
            discord_events_channel_id: model.discord_events_channel_id,
            discord_battles_channel_id: model.discord_battles_channel_id,
            discord_battles_cta_channel_id: model.discord_battles_cta_channel_id,
            discord_audit_log_channel_id: model.discord_audit_log_channel_id,
            discord_transaction_spam_channel_id: model.discord_transaction_spam_channel_id,
            discord_event_role_id: model.discord_event_role_id,
        }
    }
}

/// Request body for `PUT /admin/settings`.
///
/// Partial update: a field entirely absent from the JSON body is left unchanged, matching
/// `UpdateRegearSettingsRequest`'s convention elsewhere in this codebase. To clear an
/// already-configured channel, send it as an empty string rather than `null` — the service
/// normalizes `Some("")` to "unset this column". This avoids the serde "double option" dance a
/// true `Option<Option<String>>` would need to tell "absent" and "present but null" apart, and the
/// admin settings form always sends every field anyway (either a ~19-digit Discord snowflake or
/// empty), so there is no real case where a client needs `null` specifically.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateGuildSettingsRequest {
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_events_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_battles_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_battles_cta_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_audit_log_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_transaction_spam_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_event_role_id: Option<String>,
}
