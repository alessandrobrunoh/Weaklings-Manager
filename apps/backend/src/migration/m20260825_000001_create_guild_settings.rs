//! Creates the `guild_settings` singleton table and moves the Discord channel/role IDs that used
//! to live only in deployment env vars into it, so an admin can edit them from the web app
//! without a redeploy.
//!
//! Six IDs move here:
//! - `discord_events_channel_id` / `discord_battles_channel_id` — previously the bot's own
//!   `DISCORD_EVENTS_CHANNEL_ID` / `DISCORD_BATTLES_CHANNEL_ID`.
//! - `discord_battles_cta_channel_id` — previously the backend's `DISCORD_BATTLES_CTA_CHANNEL_ID`.
//! - `discord_audit_log_channel_id` / `discord_transaction_spam_channel_id` — previously the
//!   backend's `DISCORD_AUDIT_LOG_CHANNEL_ID` / `DISCORD_TRANSACTION_SPAM_CHANNEL_ID`.
//! - `discord_event_role_id` — previously *two* independent env vars that had to be kept in sync
//!   by hand: the backend's `DISCORD_EVENT_ROLE_ID` and the bot's `EVENT_ROLE_ID` (with its
//!   `EVENT_PING_ROLE_ID` legacy alias). One field now, so they cannot drift apart.
//!
//! The seed step reads whichever of the old env vars happen to be set at migration time, so an
//! existing deployment keeps working with the same channels the moment it upgrades — only new
//! changes go through the admin UI afterward.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(GuildSettings::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GuildSettings::Id)
                            .big_integer()
                            .not_null()
                            .primary_key()
                            .default(1),
                    )
                    .col(ColumnDef::new(GuildSettings::DiscordEventsChannelId).string_len(64))
                    .col(ColumnDef::new(GuildSettings::DiscordBattlesChannelId).string_len(64))
                    .col(ColumnDef::new(GuildSettings::DiscordBattlesCtaChannelId).string_len(64))
                    .col(ColumnDef::new(GuildSettings::DiscordAuditLogChannelId).string_len(64))
                    .col(
                        ColumnDef::new(GuildSettings::DiscordTransactionSpamChannelId)
                            .string_len(64),
                    )
                    .col(ColumnDef::new(GuildSettings::DiscordEventRoleId).string_len(64))
                    .col(
                        ColumnDef::new(GuildSettings::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(GuildSettings::UpdatedByUserId).big_integer())
                    .to_owned(),
            )
            .await?;

        // One-time carry-over from the env vars this table replaces, so an upgrading deployment
        // does not go dark on its Discord integrations. `env::var` reads whatever the migration
        // process itself was started with — the same process that used to read these values
        // directly, just one release earlier.
        let events_channel = std::env::var("DISCORD_EVENTS_CHANNEL_ID").ok();
        let battles_channel = std::env::var("DISCORD_BATTLES_CHANNEL_ID").ok();
        let cta_channel = std::env::var("DISCORD_BATTLES_CTA_CHANNEL_ID").ok();
        let audit_channel = std::env::var("DISCORD_AUDIT_LOG_CHANNEL_ID").ok();
        let spam_channel = std::env::var("DISCORD_TRANSACTION_SPAM_CHANNEL_ID").ok();
        // Prefer the backend's own var; fall back to the bot's readable name, then its legacy alias.
        let event_role = std::env::var("DISCORD_EVENT_ROLE_ID")
            .or_else(|_| std::env::var("EVENT_ROLE_ID"))
            .or_else(|_| std::env::var("EVENT_PING_ROLE_ID"))
            .ok();

        manager
            .exec_stmt(
                Query::insert()
                    .into_table(GuildSettings::Table)
                    .columns([
                        GuildSettings::Id,
                        GuildSettings::DiscordEventsChannelId,
                        GuildSettings::DiscordBattlesChannelId,
                        GuildSettings::DiscordBattlesCtaChannelId,
                        GuildSettings::DiscordAuditLogChannelId,
                        GuildSettings::DiscordTransactionSpamChannelId,
                        GuildSettings::DiscordEventRoleId,
                    ])
                    .values_panic([
                        1.into(),
                        events_channel.into(),
                        battles_channel.into(),
                        cta_channel.into(),
                        audit_channel.into(),
                        spam_channel.into(),
                        event_role.into(),
                    ])
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(GuildSettings::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    Id,
    DiscordEventsChannelId,
    DiscordBattlesChannelId,
    DiscordBattlesCtaChannelId,
    DiscordAuditLogChannelId,
    DiscordTransactionSpamChannelId,
    DiscordEventRoleId,
    UpdatedAt,
    UpdatedByUserId,
}
