//! Seeds operational permissions for the officer and administrator role aliases.
//!
//! The initial Siphoned seed only recognised `Admin` and `Moderator`, while
//! Warns shipped without a role-permission seed. Guilds using the common
//! `SUPERADMIN` role name therefore received read-only pages despite holding
//! an administrative role.

use sea_orm_migration::prelude::*;

/// Grants Siphoned and Warn management to the built-in officer-level role names.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();
        let rows = db
            .query_all(
                backend.build(
                    &Query::select()
                        .column(Roles::Id)
                        .column(Roles::Name)
                        .from(Roles::Table)
                        .to_owned(),
                ),
            )
            .await?;

        let permissions = [
            "siphoned.view",
            "siphoned.ingest",
            "warns.view",
            "warns.issue",
        ];

        for row in rows {
            let role_id: String = row.try_get_by_index(0)?;
            let role_name: String = row.try_get_by_index(1)?;
            let normalized = role_name.trim().to_ascii_lowercase();
            if !matches!(
                normalized.as_str(),
                "officer" | "moderator" | "admin" | "superadmin" | "super admin"
            ) {
                continue;
            }

            for permission in permissions {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.clone().into(), permission.into()])
                            .on_conflict(OnConflict::new().do_nothing().to_owned())
                            .to_owned(),
                    ),
                )
                .await?;
            }
        }

        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        // This is a corrective permission seed. Removing it would also remove
        // grants that may have been intentionally retained by an administrator.
        Ok(())
    }
}

#[derive(DeriveIden)]
enum RolePermissions {
    Table,
    RoleId,
    Permission,
}

#[derive(DeriveIden)]
enum Roles {
    Table,
    Id,
    Name,
}
