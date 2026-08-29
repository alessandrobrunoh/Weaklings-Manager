//! Decouples gestionale roles from Discord snowflakes.
//!
//! Until now `roles.id` *was* the Discord role id, so a role could only exist as a 1:1 copy of a
//! Discord role and could only be created by inserting that snowflake as the primary key. The
//! admin flow is "create a role here, then link it to a Discord role", which needs:
//!
//! - `discord_role_id`: optional unique snowflake; login/`/me` match on this, not on `id`
//! - `is_default`: the fallback role for members who hold no linked Discord role
//!
//! Existing rows keep working: their current `id` (a snowflake) is copied into `discord_role_id`.
//! New roles get a UUID `id` from the API.

use sea_orm_migration::prelude::*;

/// Migration step to add Discord-link columns to `roles` and seed `roles.manage`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .add_column(ColumnDef::new(Roles::DiscordRoleId).string().null())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .add_column(
                        ColumnDef::new(Roles::IsDefault)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        let db = manager.get_connection();
        db.execute_unprepared("UPDATE roles SET discord_role_id = id WHERE discord_role_id IS NULL")
            .await?;
        db.execute_unprepared("UPDATE roles SET is_default = true WHERE name = 'User'")
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_roles_discord_role_id")
                    .table(Roles::Table)
                    .col(Roles::DiscordRoleId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // At most one default fallback role. SQLite and Postgres both accept this partial index.
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_one_default ON roles (is_default) WHERE is_default = true",
        )
        .await?;

        seed_roles_manage(manager).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let backend = manager.get_database_backend();
        db.execute(
            backend.build(
                &Query::delete()
                    .from_table(RolePermissions::Table)
                    .and_where(Expr::col(RolePermissions::Permission).eq("roles.manage"))
                    .to_owned(),
            ),
        )
        .await?;

        db.execute_unprepared("DROP INDEX IF EXISTS idx_roles_one_default")
            .await?;

        manager
            .drop_index(
                Index::drop()
                    .name("idx_roles_discord_role_id")
                    .table(Roles::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .drop_column(Roles::IsDefault)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .drop_column(Roles::DiscordRoleId)
                    .to_owned(),
            )
            .await
    }
}

async fn seed_roles_manage(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
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
    let mut name_to_id = std::collections::HashMap::new();
    for row in role_rows {
        let id: String = row.try_get_by_index(0)?;
        let name: String = row.try_get_by_index(1)?;
        name_to_id.insert(name, id);
    }

    // Anyone who could already edit the matrix should be able to create/link roles.
    for role_name in ["Admin", "Officer", "Moderator"] {
        let Some(role_id) = name_to_id.get(role_name) else {
            continue;
        };
        db.execute(
            backend.build(
                &Query::insert()
                    .into_table(RolePermissions::Table)
                    .columns([RolePermissions::RoleId, RolePermissions::Permission])
                    .values_panic([role_id.clone().into(), "roles.manage".into()])
                    .on_conflict(OnConflict::new().do_nothing().to_owned())
                    .to_owned(),
            ),
        )
        .await?;
    }

    Ok(())
}

#[derive(DeriveIden)]
enum Roles {
    Table,
    Id,
    Name,
    DiscordRoleId,
    IsDefault,
}

#[derive(DeriveIden)]
enum RolePermissions {
    Table,
    RoleId,
    Permission,
}
