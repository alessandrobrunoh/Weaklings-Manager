//! Creates the control-plane `tenants` registry.
//!
//! One row per Discord guild that this deployment serves. `id` is the guild
//! snowflake itself; `schema_name` is the Postgres schema that holds that
//! tenant's data (`tenant_<id>`).

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Tenants::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Tenants::Id)
                            .string_len(64)
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Tenants::Slug)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(Tenants::Name).string().not_null())
                    .col(
                        ColumnDef::new(Tenants::SchemaName)
                            .string_len(63)
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(Tenants::Status).string().not_null())
                    .col(ColumnDef::new(Tenants::OwnerDiscordId).string_len(64))
                    .col(
                        ColumnDef::new(Tenants::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(Tenants::SuspendedAt).timestamp_with_time_zone())
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE tenants ADD CONSTRAINT tenants_status_check \
                 CHECK (status IN ('provisioning','active','suspended'))",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Tenants::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Tenants {
    Table,
    Id,
    Slug,
    Name,
    SchemaName,
    Status,
    OwnerDiscordId,
    CreatedAt,
    SuspendedAt,
}
