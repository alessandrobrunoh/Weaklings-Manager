//! Seeds the new `events.view`/`.create`/`.edit`/`.delete` permissions.
//!
//! `events.manage` (seeded to Admin/Officer by `m20260711_000004`) is being
//! decomposed into one permission per action so a custom role can, for
//! example, see events without being able to create or delete them. The old
//! `events.manage` key is untouched — nothing revokes it, so any role that
//! already has it keeps working exactly as before even if this migration's
//! `up()` is skipped or partially applied.
//!
//! `events.view` gates two previously-ungated endpoints (`GET /api/events`,
//! `GET /api/events/{id}`) that any authenticated member could call before —
//! seeded to every baseline role (not just Admin/Officer) so nobody loses the
//! ability to see the events list as a side effect of this migration.

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

        let manage_level = ["events.create", "events.edit", "events.delete"];
        let view_level = ["events.view"];
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
                    .and_where(Expr::col(RolePermissions::Permission).is_in([
                        "events.view",
                        "events.create",
                        "events.edit",
                        "events.delete",
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
