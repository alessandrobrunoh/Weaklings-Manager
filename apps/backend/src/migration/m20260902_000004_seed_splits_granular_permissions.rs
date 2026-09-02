//! Seeds `splits.view`/`.create`/`.edit`/`.delete`, decomposing `splits.manage` (seeded to
//! Admin/Officer/Moderator by `m20260710_000001` — that migration grants Officer and Moderator
//! identically as a hedge against either name being the one actually in use for the guild's
//! officer-tier role, so this one must too).
//!
//! `.view` gates three previously-ungated endpoints (list/get split, the KPI summary) — seeded to
//! every baseline role so browsing splits stays open. `.create` gates `create_split`, which was
//! *also* already open to any authenticated member (any member can request a split, an officer
//! closes it out) — seeded just as broadly, purely so the key exists to restrict later; nobody's
//! access changes today. `.edit`/`.delete` go to Admin/Officer/Moderator, matching who already
//! holds `splits.manage`.

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

        let manage_level = ["splits.edit", "splits.delete"];
        let open_level = ["splits.view", "splits.create"];
        let seeds: &[(&str, &[&str])] = &[
            ("Admin", manage_level.as_slice()),
            ("Officer", manage_level.as_slice()),
            ("Moderator", manage_level.as_slice()),
            ("Admin", open_level.as_slice()),
            ("Officer", open_level.as_slice()),
            ("Moderator", open_level.as_slice()),
            ("User", open_level.as_slice()),
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
                    .and_where(Expr::col(RolePermissions::Permission).is_in([
                        "splits.view",
                        "splits.create",
                        "splits.edit",
                        "splits.delete",
                    ]))
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
