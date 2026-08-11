//! Seeds the new `siphoned.*` permissions into `role_permissions`.
//!
//! - `User` (every authenticated member) gets `siphoned.view`.
//! - `Moderator` (officer tier) additionally gets `siphoned.ingest`.
//! - `Admin` is granted every variant of `Permission::all()` elsewhere, so it is intentionally
//!   not seeded here to avoid drift with new permission variants.

use sea_orm_migration::prelude::*;

/// Migration step to seed siphoned permissions.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();

        // Load all existing roles (id, name) so we can map by name.
        let select = backend.build(
            &Query::select()
                .column(Roles::Id)
                .column(Roles::Name)
                .from(Roles::Table)
                .to_owned(),
        );
        let role_rows = db.query_all(select).await?;

        let mut name_to_id: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for row in role_rows {
            let id: String = row.try_get_by_index(0)?;
            let name: String = row.try_get_by_index(1)?;
            name_to_id.insert(name, id);
        }

        let view_perms = ["siphoned.view"];
        let ingest_perms = ["siphoned.view", "siphoned.ingest"];
        let seeds: &[(&str, &[&str])] = &[
            ("User", view_perms.as_slice()),
            ("Moderator", ingest_perms.as_slice()),
            ("Admin", ingest_perms.as_slice()),
        ];

        for (role_name, perms) in seeds {
            let Some(role_id) = name_to_id.get(*role_name) else {
                continue;
            };
            for perm in *perms {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.clone().into(), (*perm).into()])
                            .on_conflict(OnConflict::new().do_nothing().to_owned())
                            .to_owned(),
                    ),
                )
                .await?;
            }
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();

        for perm in ["siphoned.view", "siphoned.ingest"] {
            db.execute(
                backend.build(
                    &Query::delete()
                        .from_table(RolePermissions::Table)
                        .and_where(Expr::col(RolePermissions::Permission).eq(perm))
                        .to_owned(),
                ),
            )
            .await?;
        }

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
