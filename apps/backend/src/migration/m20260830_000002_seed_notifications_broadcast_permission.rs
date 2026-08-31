//! Seeds `notifications.broadcast` into `role_permissions`.
//!
//! - `Moderator` (officer tier) can compose a guild-wide announcement.
//! - `Admin` gets the same key. Super-admin bypasses the table entirely.

use sea_orm_migration::prelude::*;

/// Migration step to seed the broadcast permission.
#[derive(DeriveMigrationName)]
pub struct Migration;

const PERM: &str = "notifications.broadcast";

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

        for role_name in ["Moderator", "Admin", "Officer"] {
            let Some(role_id) = name_to_id.get(role_name) else {
                continue;
            };
            db.execute(
                backend.build(
                    &Query::insert()
                        .into_table(RolePermissions::Table)
                        .columns([RolePermissions::RoleId, RolePermissions::Permission])
                        .values_panic([role_id.clone().into(), PERM.into()])
                        .on_conflict(OnConflict::new().do_nothing().to_owned())
                        .to_owned(),
                ),
            )
            .await?;
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
                    .and_where(Expr::col(RolePermissions::Permission).eq(PERM))
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
