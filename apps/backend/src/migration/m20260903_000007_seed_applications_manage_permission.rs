//! Grants the applications management capability to built-in officer roles.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();
        let rows = db
            .query_all(
                backend.build(
                    &Query::select()
                        .column(Roles::Id)
                        .column(Roles::Name)
                        .from(Roles::Table)
                        .to_owned(),
                ),
            )
            .await?;

        for row in rows {
            let role_id: String = row.try_get_by_index(0)?;
            let role_name: String = row.try_get_by_index(1)?;
            let role_name = role_name.trim().to_ascii_lowercase();
            if !matches!(
                role_name.as_str(),
                "admin" | "officer" | "moderator" | "superadmin" | "super admin"
            ) {
                continue;
            }

            db.execute(
                backend.build(
                    &Query::insert()
                        .into_table(RolePermissions::Table)
                        .columns([RolePermissions::RoleId, RolePermissions::Permission])
                        .values_panic([role_id.into(), "applications.manage".into()])
                        .on_conflict(OnConflict::new().do_nothing().to_owned())
                        .to_owned(),
                ),
            )
            .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DELETE FROM role_permissions WHERE permission = 'applications.manage'",
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
