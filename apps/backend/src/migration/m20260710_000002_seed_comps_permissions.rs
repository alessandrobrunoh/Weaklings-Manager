//! Seeds the 4 new `comps.*` permissions into `role_permissions` for Admin and Officer roles.
//!
//! This migration runs after `m20260710_000001_create_role_permissions` (which creates the
//! `role_permissions` table). It mirrors that migration's role-name-lookup approach: load roles
//! by name, insert the new permissions for "Admin" and "Officer" using `OnConflict::new().do_nothing()`
//! so it's idempotent on existing DBs.

use sea_orm_migration::prelude::*;

/// Migration step to seed comps permissions.
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

        // Build a name -> id lookup. try_get_by_index matches the SELECT column order.
        let mut name_to_id: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for row in role_rows {
            let id: String = row.try_get_by_index(0)?;
            let name: String = row.try_get_by_index(1)?;
            name_to_id.insert(name, id);
        }

        // Permission seeds per role name. The 4 new comps permissions:
        // - comps.build_categories.manage
        // - comps.comp_categories.manage
        // - comps.builds.manage
        // - comps.comps.manage
        let admin_perms = [
            "comps.build_categories.manage",
            "comps.comp_categories.manage",
            "comps.builds.manage",
            "comps.comps.manage",
        ];
        let officer_perms = [
            "comps.build_categories.manage",
            "comps.comp_categories.manage",
            "comps.builds.manage",
            "comps.comps.manage",
        ];

        let seeds: &[(&str, &[&str])] = &[
            ("Admin", admin_perms.as_slice()),
            ("Officer", officer_perms.as_slice()),
        ];

        for (role_name, perms) in seeds {
            let Some(role_id) = name_to_id.get(*role_name) else {
                // Role not present in the `roles` table — skip silently.
                continue;
            };
            for perm in *perms {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.clone().into(), (*perm).into()])
                            .on_conflict(
                                OnConflict::new()
                                    .do_nothing()
                                    .to_owned(),
                            )
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

        // Remove the 4 new comps permissions from all roles.
        let perms = [
            "comps.build_categories.manage",
            "comps.comp_categories.manage",
            "comps.builds.manage",
            "comps.comps.manage",
        ];

        for perm in perms {
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
