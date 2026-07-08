use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(AlbionLinks::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(AlbionLinks::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(AlbionLinks::DiscordId).string().not_null().unique_key())
                    .col(
                        ColumnDef::new(AlbionLinks::AlbionPlayerId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(AlbionLinks::AlbionPlayerName).string().not_null())
                    .col(
                        ColumnDef::new(AlbionLinks::LinkedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(AlbionLinks::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum AlbionLinks {
    Table,
    Id,
    DiscordId,
    AlbionPlayerId,
    AlbionPlayerName,
    LinkedAt,
}
