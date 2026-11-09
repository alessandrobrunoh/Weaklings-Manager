//! Pending self-service Albion link claims.
//!
//! Albion offers no way to prove who owns a character, so a self-service link is only a
//! *request* until an officer approves it. Requests live apart from `albion_links` on purpose:
//! everything that attributes loot, regears or splits to a character reads `albion_links`, and a
//! claim nobody vetted must not reach any of it.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(AlbionLinkRequests::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(AlbionLinkRequests::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // One open request per Discord account: asking again replaces it.
                    .col(
                        ColumnDef::new(AlbionLinkRequests::DiscordId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    // Not unique: several accounts may claim the same character, and the officer
                    // picks the real owner.
                    .col(
                        ColumnDef::new(AlbionLinkRequests::AlbionPlayerId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AlbionLinkRequests::AlbionPlayerName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(AlbionLinkRequests::AlbionGuildName).string())
                    // `self` (`POST /albion/link`) or `register` (`POST /albion/register`).
                    .col(
                        ColumnDef::new(AlbionLinkRequests::Via)
                            .string()
                            .not_null()
                            .default("self"),
                    )
                    .col(
                        ColumnDef::new(AlbionLinkRequests::RequestedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_albion_link_requests_player")
                    .table(AlbionLinkRequests::Table)
                    .col(AlbionLinkRequests::AlbionPlayerId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(AlbionLinkRequests::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum AlbionLinkRequests {
    Table,
    Id,
    DiscordId,
    AlbionPlayerId,
    AlbionPlayerName,
    AlbionGuildName,
    Via,
    RequestedAt,
}
