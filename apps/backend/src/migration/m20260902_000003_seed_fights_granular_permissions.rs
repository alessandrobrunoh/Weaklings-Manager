//! Seeds `fights.view`/`fights.edit`, decomposing `fights.manage` (seeded to Admin/Officer by
//! `m20260901_000008`). fights.rs only ever mutates existing fight groupings (merge/move/split —
//! nothing is created or deleted from scratch), so unlike events/comps this splits into just two
//! keys, not four; a .create/.delete pair would have no handler to attach to.
//!
//! .view gates three previously-ungated endpoints (list/get fight, get trends) that any
//! authenticated member could call before — seeded to every baseline role so nobody loses that.

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

        let edit_level = ["fights.edit"];
        let view_level = ["fights.view"];
        let seeds: &[(&str, &[&str])] = &[
            ("Admin", edit_level.as_slice()),
            ("Officer", edit_level.as_slice()),
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
                    .and_where(
                        Expr::col(RolePermissions::Permission)
                            .is_in(["fights.view", "fights.edit"]),
                    )
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
