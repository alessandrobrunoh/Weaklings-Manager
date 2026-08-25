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
    /// Last admin edit.
    pub updated_at: DateTimeWithTimeZone,
    /// Last admin editor.
    pub updated_by_user_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
