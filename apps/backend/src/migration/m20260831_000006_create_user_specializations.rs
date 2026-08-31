//! Creates the per-user Albion combat specialization levels table.

use sea_orm_migration::prelude::*;

/// Migration for persisted Albion combat specialization levels.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(UserSpecializations::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(UserSpecializations::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::NodeKey)
                            .string_len(128)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::NodeName)
                            .string_len(160)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::Category)
                            .string_len(16)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::Level)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(UserSpecializations::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(UserSpecializations::UpdatedByUserId).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_user_specializations_user_id")
                            .from(UserSpecializations::Table, UserSpecializations::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_user_specializations_user_node_unique")
                    .table(UserSpecializations::Table)
                    .col(UserSpecializations::UserId)
                    .col(UserSpecializations::NodeKey)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UserSpecializations::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum UserSpecializations {
    Table,
    Id,
    UserId,
    NodeKey,
    NodeName,
    Category,
    Level,
    UpdatedAt,
    UpdatedByUserId,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
