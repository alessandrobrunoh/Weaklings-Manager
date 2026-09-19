//! Seeds `intel.opponents.view`, gating the new enemy guild/player dossier
//! endpoints (`GET /api/enemies/...`).
//!
//! Granted to the same roles that already hold `intel.report.view`
//! (`Moderator` and `Admin` — see `m20260823_000002_seed_intel_permissions`):
//! opponent dossiers are an extension of existing intel visibility, not a new
//! tier, so nobody who can already see the guild report should be blocked
//! from seeing an enemy dossier.
//!
//! Permission keys are the stable strings persisted in
//! `role_permissions.permission` — never rename them or existing rows will be
//! orphaned.

use sea_orm_migration::prelude::*;

/// Migration step to seed the `intel.opponents.view` permission.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// Every permission this migration owns, used for both seeding and rollback.
const ENEMY_INTEL_PERMISSIONS: [&str; 1] = ["intel.opponents.view"];

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

        // Same roles as intel.report.view — see module doc comment.
        let officer_perms = ["intel.opponents.view"];
        let seeds: &[(&str, &[&str])] = &[
            ("Moderator", officer_perms.as_slice()),
            ("Admin", officer_perms.as_slice()),
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
                    .and_where(
                        Expr::col(RolePermissions::Permission).is_in(ENEMY_INTEL_PERMISSIONS),
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
