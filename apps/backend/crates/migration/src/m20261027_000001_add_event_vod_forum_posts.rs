//! Stores opt-in VOD forum post delivery for newly created events.

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
                    // Existing events stay disabled: this is intentionally not a backfill.
                    .add_column(
                        ColumnDef::new(Alias::new("vod_forum_post_enabled"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .add_column(
                        ColumnDef::new(Alias::new("vod_forum_post_status"))
                            .string()
                            .not_null()
                            .default("not_requested"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .add_column(ColumnDef::new(Alias::new("vod_forum_thread_id")).string_len(64))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("vod_forum_thread_id"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("vod_forum_post_status"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("vod_forum_post_enabled"))
                    .to_owned(),
            )
            .await
    }
}
