//! Request and response types for the admin module.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One role and the permissions currently granted to it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RolePermissionsView {
    /// Internal primary key of `roles` (UUID for newly created rows).
    pub role_id: String,
    /// Human-readable role name.
    pub role_name: String,
    /// Ordering weight; higher wins when a member holds several roles.
    pub priority: i32,
    /// Linked Discord guild role snowflake, if any.
    pub discord_role_id: Option<String>,
    /// When true, unmatched Discord members fall through to this role.
    pub is_default: bool,
    /// Unique generic staff ping role linked to the Discord role used for `@staff`.
    pub is_staff: bool,
    /// Holders also receive the generic staff Discord role.
    pub grants_staff: bool,
    /// Permission keys granted to this role.
    pub permissions: Vec<String>,
}

/// Request body to create a gestionale role, optionally linked to a Discord role.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateRoleRequest {
    /// Display name; must be unique.
    pub name: String,
    /// Ordering weight; higher wins for `highest_role`.
    #[serde(default)]
    pub priority: i32,
    /// Discord snowflake to link. Omit or empty to leave unlinked.
    pub discord_role_id: Option<String>,
    /// When true, this becomes the unmatched-member fallback (unsets the previous default).
    #[serde(default)]
    pub is_default: bool,
    /// When true, this becomes the unique generic staff ping role (unsets the previous staff role).
    #[serde(default)]
    pub is_staff: bool,
    /// When true, assigning this role also assigns the generic staff Discord role.
    #[serde(default)]
    pub grants_staff: bool,
}

/// Partial update for a gestionale role. Absent fields stay unchanged; empty `discord_role_id` unlinks.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateRoleRequest {
    /// New display name.
    pub name: Option<String>,
    /// New priority.
    pub priority: Option<i32>,
    /// New Discord snowflake. Send `""` to unlink.
    pub discord_role_id: Option<String>,
    /// Set or clear default fallback status.
    pub is_default: Option<bool>,
    /// Set or clear generic staff ping status.
    pub is_staff: Option<bool>,
    /// Set or clear whether holders also receive the generic staff Discord role.
    pub grants_staff: Option<bool>,
}

/// Grouping metadata for one assignable permission key.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PermissionCatalogEntry {
    /// Stable key stored in `role_permissions`.
    pub key: String,
    /// First segment of the key, used to group the matrix (`bank`, `regear`, …).
    pub resource: String,
    /// Remainder of the key (`withdraw.accept`, `manage`, …).
    pub action: String,
}

/// The whole authorization matrix, plus the full set of assignable keys.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PermissionMatrix {
    /// Every role known to the system, highest priority first.
    pub roles: Vec<RolePermissionsView>,
    /// Every permission the backend can gate on, so the UI can render the
    /// full grid rather than only what happens to be granted today.
    pub available_permissions: Vec<String>,
    /// Same keys as `available_permissions`, with resource/action split for grouping.
    pub permission_catalog: Vec<PermissionCatalogEntry>,
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
    /// Role assigned automatically to human members joining the Discord guild.
    pub discord_auto_role_id: Option<String>,
    /// Discord snowflake linked to the unique gestionale `is_default` role, if any.
    ///
    /// Computed from `roles` on read; not stored on `guild_settings`.
    pub default_role_discord_id: Option<String>,
    /// Forum Channel where the bot creates one thread per loot split.
    pub discord_splits_forum_channel_id: Option<String>,
    /// Forum tag applied to pending split posts.
    pub discord_split_pending_tag_id: Option<String>,
    /// Forum tag applied to completed split posts.
    pub discord_split_completed_tag_id: Option<String>,
    /// Forum tag applied to not-completed split posts.
    pub discord_split_not_completed_tag_id: Option<String>,
    /// Forum tag applied to lost split posts.
    pub discord_split_lost_tag_id: Option<String>,
    /// Category where the bot creates live event voice channels.
    pub discord_event_voice_category_id: Option<String>,
    /// Channel where the application panel is published.
    pub discord_applications_channel_id: Option<String>,
    /// Category where active application channels are created.
    pub discord_applications_category_id: Option<String>,
    /// Optional archive category for resolved applications.
    pub discord_applications_archive_category_id: Option<String>,
    /// Role allowed to manage applications.
    pub discord_applications_manage_role_id: Option<String>,
    /// Channel for application open/closed announcements.
    pub discord_applications_status_channel_id: Option<String>,
    /// Whether new applications are accepted.
    pub discord_applications_open: bool,
    /// Application panel title.
    pub discord_applications_panel_title: String,
    /// Application panel message.
    pub discord_applications_panel_message: String,
    /// Title shown when a manager opens the application actions.
    pub discord_applications_manage_title: String,
    /// Message shown when a manager opens the application actions.
    pub discord_applications_manage_message: String,
    /// Message shown when applications are closed.
    pub discord_applications_closed_message: String,
    pub discord_applications_closed_title: String,
    pub discord_applications_close_title: String,
    pub discord_applications_close_message: String,
    pub discord_applications_accept_title: String,
    pub discord_applications_decline_title: String,
    pub discord_applications_no_permission_title: String,
    pub discord_applications_already_open_title: String,
    pub discord_applications_final_title: String,
    /// Message shown when the actor lacks application permissions.
    pub discord_applications_no_permission_message: String,
    /// Message shown when the applicant already has an open application.
    pub discord_applications_already_open_message: String,
    /// Message shown after accepting an application.
    pub discord_applications_accept_message: String,
    /// Message shown after declining an application.
    pub discord_applications_decline_message: String,
    /// Message shown when application processing fails.
    pub discord_applications_error_message: String,
    /// Message shown after an application action completes.
    pub discord_applications_result_message: String,
    /// Application welcome title.
    pub discord_applications_welcome_title: String,
    /// Application welcome message.
    pub discord_applications_welcome_message: String,
    /// Announcement sent when applications open.
    pub discord_applications_status_open_message: String,
    /// Announcement sent when applications close.
    pub discord_applications_status_closed_message: String,
    /// Message ID of the published application panel, when available.
    pub discord_applications_panel_message_id: Option<String>,
    /// Channel where the bot announces guild giveaways.
    pub discord_giveaways_channel_id: Option<String>,
    /// Optional role pinged on a new giveaway announcement.
    pub discord_giveaways_role_id: Option<String>,
    /// Default percentage fee applied to new splits.
    #[schema(value_type = String, example = "20.00")]
    pub default_split_fee: rust_decimal::Decimal,
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
            discord_auto_role_id: model.discord_auto_role_id,
            default_role_discord_id: None,
            discord_splits_forum_channel_id: model.discord_splits_forum_channel_id,
            discord_split_pending_tag_id: model.discord_split_pending_tag_id,
            discord_split_completed_tag_id: model.discord_split_completed_tag_id,
            discord_split_not_completed_tag_id: model.discord_split_not_completed_tag_id,
            discord_split_lost_tag_id: model.discord_split_lost_tag_id,
            discord_event_voice_category_id: model.discord_event_voice_category_id,
            discord_applications_channel_id: model.discord_applications_channel_id,
            discord_applications_category_id: model.discord_applications_category_id,
            discord_applications_archive_category_id: model
                .discord_applications_archive_category_id,
            discord_applications_manage_role_id: model.discord_applications_manage_role_id,
            discord_applications_status_channel_id: model.discord_applications_status_channel_id,
            discord_applications_open: model.discord_applications_open,
            discord_applications_panel_title: model.discord_applications_panel_title,
            discord_applications_panel_message: model.discord_applications_panel_message,
            discord_applications_manage_title: model.discord_applications_manage_title,
            discord_applications_manage_message: model.discord_applications_manage_message,
            discord_applications_closed_message: model.discord_applications_closed_message,
            discord_applications_closed_title: model.discord_applications_closed_title,
            discord_applications_close_title: model.discord_applications_close_title,
            discord_applications_close_message: model.discord_applications_close_message,
            discord_applications_accept_title: model.discord_applications_accept_title,
            discord_applications_decline_title: model.discord_applications_decline_title,
            discord_applications_no_permission_title: model
                .discord_applications_no_permission_title,
            discord_applications_already_open_title: model.discord_applications_already_open_title,
            discord_applications_final_title: model.discord_applications_final_title,
            discord_applications_no_permission_message: model
                .discord_applications_no_permission_message,
            discord_applications_already_open_message: model
                .discord_applications_already_open_message,
            discord_applications_accept_message: model.discord_applications_accept_message,
            discord_applications_decline_message: model.discord_applications_decline_message,
            discord_applications_error_message: model.discord_applications_error_message,
            discord_applications_result_message: model.discord_applications_result_message,
            discord_applications_welcome_title: model.discord_applications_welcome_title,
            discord_applications_welcome_message: model.discord_applications_welcome_message,
            discord_applications_status_open_message: model
                .discord_applications_status_open_message,
            discord_applications_status_closed_message: model
                .discord_applications_status_closed_message,
            discord_applications_panel_message_id: model.discord_applications_panel_message_id,
            discord_giveaways_channel_id: model.discord_giveaways_channel_id,
            discord_giveaways_role_id: model.discord_giveaways_role_id,
            default_split_fee: model.default_split_fee,
        }
    }
}

/// A Discord role available for AutoRole configuration.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DiscordRoleView {
    /// Discord role snowflake.
    pub id: String,
    /// Role name shown in the admin panel.
    pub name: String,
    /// Discord hierarchy position; higher roles have a greater position.
    pub position: i32,
    /// Whether Discord manages this role and prevents manual assignment.
    pub managed: bool,
}

/// One tag on a Discord forum channel.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DiscordForumTagView {
    /// Forum tag snowflake.
    pub id: String,
    /// Tag name shown in Discord.
    pub name: String,
}

/// A Discord guild channel, category, or forum the admin can pick from.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DiscordChannelView {
    /// Channel snowflake.
    pub id: String,
    /// Channel name without the leading `#`.
    pub name: String,
    /// Coarse kind used by searchable pickers: `text`, `voice`, `category`, or `forum`.
    pub kind: String,
    /// Raw Discord channel type integer.
    pub type_id: i32,
    /// Parent category snowflake, when the channel sits in one.
    pub parent_id: Option<String>,
    /// Discord position within the parent.
    pub position: i32,
    /// Forum tags, populated only for forum channels.
    pub available_tags: Vec<DiscordForumTagView>,
}

/// Current AutoRole configuration.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AutoRoleSettingsView {
    /// Configured Discord role snowflake, or `null` when disabled.
    pub discord_auto_role_id: Option<String>,
    /// Discord role linked to the gestionale default role, if any.
    pub default_role_discord_id: Option<String>,
}

/// Request body for the AutoRole configuration endpoint.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateAutoRoleRequest {
    /// Discord role snowflake; an empty string disables AutoRole.
    pub discord_auto_role_id: String,
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
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
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
    /// Base guild role assigned on Discord join. Omit to leave unchanged; send `""` to clear.
    pub discord_auto_role_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_splits_forum_channel_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_split_pending_tag_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_split_completed_tag_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_split_not_completed_tag_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_split_lost_tag_id: Option<String>,
    /// New value. Omit to leave unchanged; send `""` to clear.
    pub discord_event_voice_category_id: Option<String>,
    /// Giveaway announcement channel. Omit to leave unchanged; send `""` to clear.
    pub discord_giveaways_channel_id: Option<String>,
    /// Giveaway ping role. Omit to leave unchanged; send `""` to clear.
    pub discord_giveaways_role_id: Option<String>,
    /// New application panel channel; empty clears it.
    pub discord_applications_channel_id: Option<String>,
    /// New active application category; empty clears it.
    pub discord_applications_category_id: Option<String>,
    /// New archive category; empty clears it.
    pub discord_applications_archive_category_id: Option<String>,
    /// New application manager role; empty clears it.
    pub discord_applications_manage_role_id: Option<String>,
    /// New application status channel; empty clears it.
    pub discord_applications_status_channel_id: Option<String>,
    /// New application open state.
    pub discord_applications_open: Option<bool>,
    /// New panel title.
    pub discord_applications_panel_title: Option<String>,
    /// New panel message.
    pub discord_applications_panel_message: Option<String>,
    /// New manager action title.
    pub discord_applications_manage_title: Option<String>,
    /// New manager action message.
    pub discord_applications_manage_message: Option<String>,
    /// New closed-application message.
    pub discord_applications_closed_message: Option<String>,
    pub discord_applications_closed_title: Option<String>,
    pub discord_applications_close_title: Option<String>,
    pub discord_applications_close_message: Option<String>,
    pub discord_applications_accept_title: Option<String>,
    pub discord_applications_decline_title: Option<String>,
    pub discord_applications_no_permission_title: Option<String>,
    pub discord_applications_already_open_title: Option<String>,
    pub discord_applications_final_title: Option<String>,
    /// New insufficient-permission message.
    pub discord_applications_no_permission_message: Option<String>,
    /// New already-open message.
    pub discord_applications_already_open_message: Option<String>,
    /// New accept result message.
    pub discord_applications_accept_message: Option<String>,
    /// New decline result message.
    pub discord_applications_decline_message: Option<String>,
    /// New application error message.
    pub discord_applications_error_message: Option<String>,
    /// New generic result message.
    pub discord_applications_result_message: Option<String>,
    /// New application welcome title.
    pub discord_applications_welcome_title: Option<String>,
    /// New application welcome message.
    pub discord_applications_welcome_message: Option<String>,
    /// New open announcement message.
    pub discord_applications_status_open_message: Option<String>,
    /// New closed announcement message.
    pub discord_applications_status_closed_message: Option<String>,
    /// New panel message ID; empty clears it.
    pub discord_applications_panel_message_id: Option<String>,
    /// New default split fee percentage. Must be between 0 and 100.
    #[schema(value_type = Option<String>, example = "20.00")]
    pub default_split_fee: Option<rust_decimal::Decimal>,
}
