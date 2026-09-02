//! Sea-ORM entity for the `guild_settings` singleton table.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Singleton table holding the guild's Discord integration settings (admin-editable).
///
/// Every column is nullable: a deployment may not want, say, transaction-spam posting at all, and
/// leaving a channel unset is how that's expressed — the code paths that consume these already
/// treat an absent channel as "skip this notification", the same as the env vars they replace did.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "guild_settings")]
pub struct Model {
    /// Always `1` (singleton guard).
    #[sea_orm(primary_key)]
    pub id: i64,
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
    /// Channel where application open/closed announcements are published.
    pub discord_applications_status_channel_id: Option<String>,
    /// Whether new applications are currently accepted.
    pub discord_applications_open: bool,
    /// Application panel title.
    pub discord_applications_panel_title: String,
    /// Application panel message.
    pub discord_applications_panel_message: String,
    /// Default fee percentage applied to new loot splits when no fee is provided.
    pub default_split_fee: Decimal,
    /// Last admin edit.
    pub updated_at: DateTimeWithTimeZone,
    /// Last admin editor.
    pub updated_by_user_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
