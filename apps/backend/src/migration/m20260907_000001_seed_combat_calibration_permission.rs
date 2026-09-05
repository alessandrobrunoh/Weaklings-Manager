//! Seeds the `combat.calibration.view` permission.
//!
//! Officers only, unlike `combat.tests.view`/`combat.calculator.use`: this endpoint surfaces
//! per-member prediction accuracy (a diagnostic for tuning the Item Power model), not something
//! every member has a reason to see about themselves or their guildmates.

use sea_orm_migration::prelude::*;

/// Grants `combat.calibration.view` to officer-tier roles.
#[derive(DeriveMigrationName)]
pub struct Migration;

const VIEW: &str = "combat.calibration.view";

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
            let normalized = role_name.trim().to_ascii_lowercase();
            let is_officer = matches!(
                normalized.as_str(),
                "officer" | "moderator" | "admin" | "superadmin" | "super admin"
            );
            if !is_officer {
                continue;
            }

            db.execute(
                backend.build(
                    &Query::insert()
                        .into_table(RolePermissions::Table)
                        .columns([RolePermissions::RoleId, RolePermissions::Permission])
                        .values_panic([role_id.clone().into(), VIEW.into()])
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
                "DELETE FROM role_permissions WHERE permission = 'combat.calibration.view'",
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
