//! Seeds the new `regear.*` permissions into `role_permissions`.
//!
//! - `User` (every authenticated member) gets `regear.view` and `regear.request`.
//! - `Moderator` (officer tier) additionally gets `regear.adjudicate`.
//! - `Admin` gets all four (including `regear.settings.manage`).
//!
//! Permission keys are the stable strings persisted in `role_permissions.permission` — never
//! rename them or existing rows will be orphaned.

use sea_orm_migration::prelude::*;

/// Migration step to seed regear permissions.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();

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

        let member_perms = ["regear.view", "regear.request"];
        let officer_perms = ["regear.view", "regear.request", "regear.adjudicate"];
        let admin_perms = [
            "regear.view",
            "regear.request",
            "regear.adjudicate",
            "regear.settings.manage",
        ];

        let seeds: &[(&str, &[&str])] = &[
            ("User", member_perms.as_slice()),
            ("Moderator", officer_perms.as_slice()),
            ("Admin", admin_perms.as_slice()),
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

        for perm in [
            "regear.view",
            "regear.request",
            "regear.adjudicate",
            "regear.settings.manage",
        ] {
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
