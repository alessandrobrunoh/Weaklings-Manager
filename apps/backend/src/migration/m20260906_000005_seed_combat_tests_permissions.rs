//! Seeds the combat test permissions.
//!
//! `combat.tests.view` goes to every role: reading and running a saved scenario is the same kind
//! of self-service information the Item Power calculator already is to every member.
//! `combat.tests.manage` (create, edit, archive) goes to officers only, matching how build and comp
//! authoring is gated elsewhere.

use sea_orm_migration::prelude::*;

/// Grants the combat test permissions.
#[derive(DeriveMigrationName)]
pub struct Migration;

const VIEW: &str = "combat.tests.view";
const MANAGE: &str = "combat.tests.manage";

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

            let mut permissions = vec![VIEW];
            if is_officer {
                permissions.push(MANAGE);
            }

            for permission in permissions {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.clone().into(), permission.into()])
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
            .get_connection()
            .execute_unprepared(
                "DELETE FROM role_permissions \
                 WHERE permission IN ('combat.tests.view', 'combat.tests.manage')",
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
