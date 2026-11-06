//! Member lifecycle columns on the tenant `users` table (MS-S2).

use sea_orm_migration::prelude::*;

/// Adds the membership lifecycle columns used by `users::identity::ensure_member`.
///
/// `active` is the only deactivation flag. `discord_role_ids` is the JSON snapshot of the
/// member's Discord roles, `provisioned_via` records how the row first appeared. One `ALTER`
/// per column keeps the migration SQLite-safe.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::Active)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::LeftAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(ColumnDef::new(Users::LeftReason).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::DiscordRoleIds)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::RolesCheckedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::MemberEventAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::ProvisionedVia)
                            .text()
                            .not_null()
                            .default("web"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::LastLinkChangeAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_users_active_id")
                    .table(Users::Table)
                    .col(Users::Active)
                    .col(Users::Id)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_users_active_id")
                    .table(Users::Table)
                    .to_owned(),
            )
            .await?;
        for column in [
            Users::LastLinkChangeAt,
            Users::ProvisionedVia,
            Users::MemberEventAt,
            Users::RolesCheckedAt,
            Users::DiscordRoleIds,
            Users::LeftReason,
            Users::LeftAt,
            Users::Active,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Users::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
    Active,
    LeftAt,
    LeftReason,
    DiscordRoleIds,
    RolesCheckedAt,
    MemberEventAt,
    ProvisionedVia,
    LastLinkChangeAt,
}
