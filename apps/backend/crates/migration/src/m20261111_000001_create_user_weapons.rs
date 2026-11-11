//! Creates the per-user weapon declarations table.
//!
//! One row per `(user, weapon)`. `proficiency` is the level the member declared (`main`, `good`
//! or `basic`); `NULL` means the row only exists to carry an officer lock. A row that is neither
//! declared nor locked is never stored.

use sea_orm_migration::prelude::*;

/// Migration for the member weapon declarations and officer locks.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(UserWeapons::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(UserWeapons::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UserWeapons::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserWeapons::WeaponKey)
                            .string_len(128)
                            .not_null(),
                    )
                    .col(ColumnDef::new(UserWeapons::Proficiency).string_len(16))
                    .col(
                        ColumnDef::new(UserWeapons::Locked)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(UserWeapons::LockedByUserId).big_integer())
                    .col(
                        ColumnDef::new(UserWeapons::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(UserWeapons::UpdatedByUserId).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_user_weapons_user_id")
                            .from(UserWeapons::Table, UserWeapons::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_user_weapons_user_weapon_unique")
                    .table(UserWeapons::Table)
                    .col(UserWeapons::UserId)
                    .col(UserWeapons::WeaponKey)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UserWeapons::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum UserWeapons {
    Table,
    Id,
    UserId,
    WeaponKey,
    Proficiency,
    Locked,
    LockedByUserId,
    UpdatedAt,
    UpdatedByUserId,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
