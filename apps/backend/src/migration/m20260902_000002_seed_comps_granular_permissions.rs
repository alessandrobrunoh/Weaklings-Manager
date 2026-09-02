//! Seeds the new `comps.{build_categories,comp_categories,builds,comps}.{view,create,edit,delete}`
//! permissions, decomposing the 4 existing `comps.*.manage` keys (seeded to Admin/Officer by
//! `m20260710_000002`) into one permission per action.
//!
//! The old `.manage` keys are untouched — nothing revokes them, so any role that already has one
//! keeps working exactly as before. `.view` gates previously-ungated list/get endpoints (any
//! authenticated member could browse build/comp categories, builds, and comps before), so it's
//! seeded to every baseline role, not just Admin/Officer, to preserve that behavior.

use sea_orm_migration::prelude::*;

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

        let manage_level = [
            "comps.build_categories.create",
            "comps.build_categories.edit",
            "comps.build_categories.delete",
            "comps.comp_categories.create",
            "comps.comp_categories.edit",
            "comps.comp_categories.delete",
            "comps.builds.create",
            "comps.builds.edit",
            "comps.builds.delete",
            "comps.comps.create",
            "comps.comps.edit",
            "comps.comps.delete",
        ];
        let view_level = [
            "comps.build_categories.view",
            "comps.comp_categories.view",
            "comps.builds.view",
            "comps.comps.view",
        ];
        let seeds: &[(&str, &[&str])] = &[
            ("Admin", manage_level.as_slice()),
            ("Officer", manage_level.as_slice()),
            ("Admin", view_level.as_slice()),
            ("Officer", view_level.as_slice()),
            ("Moderator", view_level.as_slice()),
            ("User", view_level.as_slice()),
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

        db.execute(
            backend.build(
                &Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(Expr::col(RolePermissions::Permission).like("comps.%.view"))
                    .to_owned(),
            ),
        )
        .await?;
        db.execute(
            backend.build(
                &Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(Expr::col(RolePermissions::Permission).like("comps.%.create"))
                    .to_owned(),
            ),
        )
        .await?;
        db.execute(
            backend.build(
                &Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(Expr::col(RolePermissions::Permission).like("comps.%.edit"))
                    .to_owned(),
            ),
        )
        .await?;
        db.execute(
            backend.build(
                &Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(Expr::col(RolePermissions::Permission).like("comps.%.delete"))
                    .to_owned(),
            ),
        )
        .await?;

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
