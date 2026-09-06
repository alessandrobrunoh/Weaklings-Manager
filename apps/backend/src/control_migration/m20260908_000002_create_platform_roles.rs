//! Platform-level roles, their permissions, and Discord-id assignments.
//!
//! Distinct from per-tenant `roles` / `role_permissions`. A platform admin is
//! a platform admin on every tenant. Seeds a single `SuperAdmin` role with the
//! three catalog permissions; Stage 2 assigns the current env superadmin to it.

use sea_orm_migration::prelude::*;

use super::{
    PERM_FEATURE_FLAGS_MANAGE, PERM_PLATFORM_ADMINS_MANAGE, PERM_TENANTS_MANAGE, SUPERADMIN_ROLE_ID,
};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PlatformRoles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlatformRoles::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PlatformRoles::Name)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(PlatformRoles::Priority).integer().not_null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PlatformRolePermissions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlatformRolePermissions::RoleId)
                            .uuid()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlatformRolePermissions::Permission)
                            .string()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(PlatformRolePermissions::RoleId)
                            .col(PlatformRolePermissions::Permission),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                PlatformRolePermissions::Table,
                                PlatformRolePermissions::RoleId,
                            )
                            .to(PlatformRoles::Table, PlatformRoles::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PlatformRoleAssignments::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlatformRoleAssignments::DiscordId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlatformRoleAssignments::PlatformRoleId)
                            .uuid()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlatformRoleAssignments::AssignedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(PlatformRoleAssignments::AssignedBy).string_len(64))
                    .primary_key(
                        Index::create()
                            .col(PlatformRoleAssignments::DiscordId)
                            .col(PlatformRoleAssignments::PlatformRoleId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                PlatformRoleAssignments::Table,
                                PlatformRoleAssignments::PlatformRoleId,
                            )
                            .to(PlatformRoles::Table, PlatformRoles::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        seed_superadmin(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(PlatformRoleAssignments::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(PlatformRolePermissions::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(PlatformRoles::Table).to_owned())
            .await
    }
}

async fn seed_superadmin(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let db = manager.get_connection();
    db.execute_unprepared(&format!(
        "INSERT INTO platform_roles (id, name, priority) \
         VALUES ('{SUPERADMIN_ROLE_ID}', 'SuperAdmin', 100)"
    ))
    .await?;
    for perm in [
        PERM_TENANTS_MANAGE,
        PERM_PLATFORM_ADMINS_MANAGE,
        PERM_FEATURE_FLAGS_MANAGE,
    ] {
        db.execute_unprepared(&format!(
            "INSERT INTO platform_role_permissions (role_id, permission) \
             VALUES ('{SUPERADMIN_ROLE_ID}', '{perm}')"
        ))
        .await?;
    }
    Ok(())
}

#[derive(DeriveIden)]
enum PlatformRoles {
    Table,
    Id,
    Name,
    Priority,
}

#[derive(DeriveIden)]
enum PlatformRolePermissions {
    Table,
    RoleId,
    Permission,
}

#[derive(DeriveIden)]
enum PlatformRoleAssignments {
    Table,
    DiscordId,
    PlatformRoleId,
    AssignedAt,
    AssignedBy,
}
