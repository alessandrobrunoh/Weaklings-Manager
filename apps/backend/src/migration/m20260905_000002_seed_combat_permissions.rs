//! Seeds the combat permissions.
//!
//! Two grants with deliberately different reach:
//!
//! * `combat.calculator.use` goes to **every** role, members included. Working out the Item Power
//!   of a build — your own or one you are being asked to fly — is self-service information, and
//!   gating it would only push members to a third-party calculator with worse numbers.
//! * `combat.readiness.view` goes to officers only. It reports on the whole guild at once (who can
//!   field what, and who is behind on training), which is roster management rather than a member
//!   looking up their own gear.

use sea_orm_migration::prelude::*;

/// Grants the Item Power calculator broadly and the readiness roll-ups to officers.
#[derive(DeriveMigrationName)]
pub struct Migration;

const CALCULATOR: &str = "combat.calculator.use";
const READINESS: &str = "combat.readiness.view";

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

            let mut permissions = vec![CALCULATOR];
            if is_officer {
                permissions.push(READINESS);
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
                 WHERE permission IN ('combat.calculator.use', 'combat.readiness.view')",
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
