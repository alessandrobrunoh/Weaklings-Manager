//! Creates the `role_permissions` table: the dynamic mapping between a role and the
//! fine-grained `Permission`s it grants. This is the single source of truth for
//! "who can do what" — changing a row here (plus a cache reload) is enough to
//! grant/revoke a capability without redeploying the backend.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(RolePermissions::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(RolePermissions::RoleId).string().not_null())
                    .col(ColumnDef::new(RolePermissions::Permission).string().not_null())
                    .primary_key(
                        Index::create()
                            .col(RolePermissions::RoleId)
                            .col(RolePermissions::Permission),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(RolePermissions::Table, RolePermissions::RoleId)
                            .to(Roles::Table, Roles::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Seed the initial mapping by looking up role IDs by name, so we don't
        // depend on hardcoded Discord role IDs (which differ per guild).
        //
        // Admin    -> every permission (inherits all)
        // Officer  -> officer-level: accept withdrawals, manage splits
        // Moderator-> officer-level (same as Officer, in case that's the name used)
        //
        // If a role name isn't found in the `roles` table, its permissions are
        // simply skipped — add them later via SQL + POST /api/admin/permissions/reload.
        let db = manager.get_connection();
        let backend = manager.get_database_backend();

        // Load all existing roles (id, name) so we can map by name.
        let select = backend.build(
            &Query::select()
                .column(Roles::Id)
                .column(Roles::Name)
                .from(Roles::Table)
                .to_owned(),
        );
        let role_rows = db.query_all(select).await?;

        // Build a name -> id lookup. Try_get by index matches the SELECT column order.
        let mut name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for row in role_rows {
            let id: String = row.try_get_by_index(0)?;
            let name: String = row.try_get_by_index(1)?;
            name_to_id.insert(name, id);
        }

        // Permission seeds per role name. Add more entries here as new roles
        // become known, or just insert directly into the DB at runtime.
        let admin_perms = [
            "bank.withdraw.accept",
            "bank.view_others",
            "splits.manage",
            "users.create",
            "permissions.reload",
        ];
        let officer_perms = ["bank.withdraw.accept", "splits.manage"];

        let seeds: &[(&str, &[&str])] = &[
            ("Admin", admin_perms.as_slice()),
            ("Officer", officer_perms.as_slice()),
            ("Moderator", officer_perms.as_slice()), // alias, in case that's the name used
        ];

        for (role_name, perms) in seeds {
            let Some(role_id) = name_to_id.get(*role_name) else {
                // Role not present in the `roles` table — skip silently.
                // The user can add the mapping later via SQL.
                continue;
            };
            for perm in *perms {
                db.execute(
                    backend.build(
                        &Query::insert()
                            .into_table(RolePermissions::Table)
                            .columns([RolePermissions::RoleId, RolePermissions::Permission])
                            .values_panic([role_id.clone().into(), (*perm).into()])
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
            .drop_table(Table::drop().table(RolePermissions::Table).to_owned())
            .await
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
