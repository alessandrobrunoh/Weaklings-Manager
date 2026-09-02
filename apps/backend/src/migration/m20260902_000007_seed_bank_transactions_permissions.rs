//! Seeds `bank.transactions.create`/`.edit`/`.delete` — the new manual transaction CRUD
//! permissions backing the `/admin/transactions` panel. There is no `bank.transactions.view`:
//! viewing the full ledger keeps reusing the existing `bank.view_others`, which already grants
//! exactly that.
//!
//! Seeded to Admin only, matching `bank.view_others`'s own scope in
//! `m20260710_000001_create_role_permissions.rs` (unlike `bank.withdraw.accept`, which also goes
//! to Officer/Moderator, `bank.view_others` was deliberately kept Admin-only — manual ledger
//! edits are at least as sensitive, so this matches that narrower scope, not the wider one).

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

        let perms = [
            "bank.transactions.create",
            "bank.transactions.edit",
            "bank.transactions.delete",
        ];
        let seeds: &[(&str, &[&str])] = &[("Admin", perms.as_slice())];

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
                        Expr::col(RolePermissions::Permission).is_in([
                            "bank.transactions.create",
                            "bank.transactions.edit",
                            "bank.transactions.delete",
                        ]),
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
