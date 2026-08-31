//! Seeds the permission used to edit another user's Albion specializations.

use sea_orm_migration::prelude::*;

/// Migration step for the specialization management permission.
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
        for row in db.query_all(select).await? {
            let role_id: String = row.try_get_by_index(0)?;
            let role_name: String = row.try_get_by_index(1)?;
            if role_name == "Admin" {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.into(), "users.specializations.manage".into()])
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
        manager
            .exec_stmt(
                Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(
                        Expr::col(RolePermissions::Permission).eq("users.specializations.manage"),
                    )
                    .to_owned(),
            )
            .await
            .map(|_| ())
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
