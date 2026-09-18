//! Creates the `trials` table and the guild-settings fields that drive the trial system.
//!
//! A trial row is the record behind "this member was accepted as a Trial": who, since when,
//! until when, and how the trial ended (`converted` when promoted to a full member, `removed`
//! when ended early). Expiry itself is *not* stored — the remaining time is always derived
//! from `ends_at`, so nothing can drift out of sync.
//!
//! Two `guild_settings` columns drive the flow:
//! - `trial_role_id` — the Discord role assigned alongside the standard role on
//!   "Accept as Trial".
//! - `trial_duration_days` — how long a trial lasts by default; the manager can still
//!   move a single trial's `ends_at` later or earlier from the dashboard.

use sea_orm_migration::prelude::*;

/// Migration step to create `trials` and add the trial columns to `guild_settings`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Trials::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Trials::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Trials::DiscordId).string_len(64).not_null())
                    .col(ColumnDef::new(Trials::UserId).big_integer())
                    .col(ColumnDef::new(Trials::ApplicationId).big_integer())
                    .col(ColumnDef::new(Trials::UsernameSnapshot).string().not_null())
                    .col(ColumnDef::new(Trials::IngameName).string())
                    .col(
                        ColumnDef::new(Trials::StartedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Trials::EndsAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Trials::Status)
                            .string_len(16)
                            .not_null()
                            .default("active"),
                    )
                    .col(ColumnDef::new(Trials::CreatedByDiscordId).string_len(64))
                    .col(ColumnDef::new(Trials::EndedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(Trials::EndedByDiscordId).string_len(64))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_trials_discord_id_status")
                    .table(Trials::Table)
                    .col(Trials::DiscordId)
                    .col(Trials::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(ColumnDef::new(GuildSettings::TrialRoleId).string_len(64))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(ColumnDef::new(GuildSettings::TrialDurationDays).integer())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::TrialDurationDays)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::TrialRoleId)
                    .to_owned(),
            )
            .await?;

        manager
            .drop_table(Table::drop().table(Trials::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Trials {
    Table,
    Id,
    DiscordId,
    UserId,
    ApplicationId,
    UsernameSnapshot,
    IngameName,
    StartedAt,
    EndsAt,
    Status,
    CreatedByDiscordId,
    EndedAt,
    EndedByDiscordId,
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    TrialRoleId,
    TrialDurationDays,
}
