//! How a new event is published on Discord: calendar, channel message, or forum post.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .add_column(
                        ColumnDef::new(Alias::new("discord_delivery"))
                            .string_len(16)
                            .not_null()
                            .default("message"),
                    )
                    .to_owned(),
            )
            .await?;
        // Organized events, including Call to Arms, go back to the single calendar
        // message. Flash masses keep the channel post they already use.
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE events SET discord_delivery = 'calendar' WHERE event_kind <> 'flash'",
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("guild_settings"))
                    .add_column(
                        ColumnDef::new(Alias::new("discord_events_forum_channel_id"))
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("discord_event_scheduled_tag_id"))
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("discord_event_live_tag_id"))
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("discord_event_cta_tag_id"))
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("discord_event_flash_tag_id"))
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("guild_settings"))
                    .drop_column(Alias::new("discord_event_flash_tag_id"))
                    .drop_column(Alias::new("discord_event_cta_tag_id"))
                    .drop_column(Alias::new("discord_event_live_tag_id"))
                    .drop_column(Alias::new("discord_event_scheduled_tag_id"))
                    .drop_column(Alias::new("discord_events_forum_channel_id"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("discord_delivery"))
                    .to_owned(),
            )
            .await
    }
}
