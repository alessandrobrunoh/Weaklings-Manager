//! Adds the optional Discord role assigned to human members on guild join.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(ColumnDef::new(GuildSettings::DiscordAutoRoleId).string_len(64))
                    .to_owned(),
            )
            .await?;

        let db = manager.get_connection();
        let backend = manager.get_database_backend();
        let admin_role = db
            .query_one(backend.build(
                &Query::select()
                    .column(Roles::Id)
                    .from(Roles::Table)
                    .and_where(Expr::col(Roles::Name).eq("Admin"))
                    .to_owned(),
            ))
            .await?;

        if let Some(row) = admin_role {
            let role_id: String = row.try_get_by_index(0)?;
            db.execute(
                backend.build(
                    &Query::insert()
                        .into_table(RolePermissions::Table)
                        .columns([RolePermissions::RoleId, RolePermissions::Permission])
                        .values_panic([role_id.into(), "autorole.manage".into()])
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
                    .and_where(Expr::col(RolePermissions::Permission).eq("autorole.manage"))
                    .to_owned(),
            ),
        )
        .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordAutoRoleId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordAutoRoleId,
}

#[derive(DeriveIden)]
enum Roles {
    Table,
    Id,
    Name,
}

#[derive(DeriveIden)]
enum RolePermissions {
    Table,
    RoleId,
    Permission,
}
