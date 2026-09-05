//! Adds staff flags to gestionale roles.
//!
//! - `is_staff`: unique generic staff ping role (the Discord role pinged as @staff)
//! - `grants_staff`: holders also receive the generic staff Discord role

use sea_orm_migration::prelude::*;

/// Migration step to add `is_staff` and `grants_staff` to `roles`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .add_column(
                        ColumnDef::new(Roles::IsStaff)
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
                    .table(Roles::Table)
                    .add_column(
                        ColumnDef::new(Roles::GrantsStaff)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_one_staff ON roles (is_staff) WHERE is_staff = true",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP INDEX IF EXISTS idx_roles_one_staff")
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .drop_column(Roles::GrantsStaff)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .drop_column(Roles::IsStaff)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Roles {
    Table,
    IsStaff,
    GrantsStaff,
}
