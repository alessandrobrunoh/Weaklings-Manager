//! Stores the in-game guild bank silver log and its reconciliation with the Manager.
//!
//! * `bank_log_entries`: one row per line of the Albion export. The export has no row id and
//!   minute precision, so two identical lines can be two real movements. `occurrence` numbers
//!   identical lines inside one export (1, 2, ...); the unique key
//!   `(occurred_at, player_key, reason, amount, occurrence)` makes re-importing an overlapping
//!   export idempotent while keeping real duplicates.
//! * `bank_log_matches` + `bank_log_match_entries` + `bank_log_match_targets`: a link between one
//!   or more log rows and one or more Manager records (paid withdrawals, a split's bags, split
//!   loot sales). Unconfirmed matches are suggestions.
//! * `created_transaction_id` is unique and has no foreign key: a row can create at most one
//!   transaction, also after that transaction is deleted.
//! * Guild settings gain the reminder channel, the seller accounts and the reminder state.
//! * `bank.log.view` / `bank.log.manage` are granted to the officer-level role names.

use sea_orm_migration::prelude::*;

/// Migration step creating the bank log tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BankLogEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BankLogEntries::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BankLogEntries::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BankLogEntries::PlayerName).string_len(64).not_null())
                    .col(ColumnDef::new(BankLogEntries::PlayerKey).string_len(64).not_null())
                    .col(ColumnDef::new(BankLogEntries::Reason).string_len(255).not_null())
                    .col(ColumnDef::new(BankLogEntries::Amount).decimal_len(16, 2).not_null())
                    .col(ColumnDef::new(BankLogEntries::Occurrence).integer().not_null())
                    .col(ColumnDef::new(BankLogEntries::Category).string_len(32).not_null())
                    .col(
                        ColumnDef::new(BankLogEntries::Status)
                            .string_len(16)
                            .not_null()
                            .default("unmatched"),
                    )
                    .col(ColumnDef::new(BankLogEntries::Note).text().null())
                    .col(
                        ColumnDef::new(BankLogEntries::ExplainedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(ColumnDef::new(BankLogEntries::ExplainedBy).big_integer().null())
                    .col(ColumnDef::new(BankLogEntries::BatchId).string_len(36).not_null())
                    .col(
                        ColumnDef::new(BankLogEntries::ImportedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BankLogEntries::ImportedBy).big_integer().null())
                    .col(
                        ColumnDef::new(BankLogEntries::CreatedTransactionId)
                            .big_integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("uq_bank_log_entries_identity")
                    .table(BankLogEntries::Table)
                    .col(BankLogEntries::OccurredAt)
                    .col(BankLogEntries::PlayerKey)
                    .col(BankLogEntries::Reason)
                    .col(BankLogEntries::Amount)
                    .col(BankLogEntries::Occurrence)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("uq_bank_log_entries_created_transaction")
                    .table(BankLogEntries::Table)
                    .col(BankLogEntries::CreatedTransactionId)
                    .unique()
                    .to_owned(),
            )
            .await?;
        for (name, column) in [
            ("idx_bank_log_entries_status", BankLogEntries::Status),
            ("idx_bank_log_entries_batch", BankLogEntries::BatchId),
            ("idx_bank_log_entries_imported_at", BankLogEntries::ImportedAt),
        ] {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(BankLogEntries::Table)
                        .col(column)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_table(
                Table::create()
                    .table(BankLogMatches::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BankLogMatches::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BankLogMatches::Kind).string_len(16).not_null())
                    .col(
                        ColumnDef::new(BankLogMatches::Confirmed)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(BankLogMatches::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BankLogMatches::CreatedBy).big_integer().null())
                    .col(
                        ColumnDef::new(BankLogMatches::ConfirmedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(ColumnDef::new(BankLogMatches::ConfirmedBy).big_integer().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BankLogMatchEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BankLogMatchEntries::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BankLogMatchEntries::MatchId).big_integer().not_null())
                    .col(ColumnDef::new(BankLogMatchEntries::EntryId).big_integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_bank_log_match_entries_match")
                            .from(BankLogMatchEntries::Table, BankLogMatchEntries::MatchId)
                            .to(BankLogMatches::Table, BankLogMatches::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_bank_log_match_entries_entry")
                            .from(BankLogMatchEntries::Table, BankLogMatchEntries::EntryId)
                            .to(BankLogEntries::Table, BankLogEntries::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("uq_bank_log_match_entries")
                    .table(BankLogMatchEntries::Table)
                    .col(BankLogMatchEntries::MatchId)
                    .col(BankLogMatchEntries::EntryId)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_bank_log_match_entries_entry")
                    .table(BankLogMatchEntries::Table)
                    .col(BankLogMatchEntries::EntryId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BankLogMatchTargets::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BankLogMatchTargets::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BankLogMatchTargets::MatchId).big_integer().not_null())
                    .col(ColumnDef::new(BankLogMatchTargets::TransactionId).big_integer().null())
                    .col(ColumnDef::new(BankLogMatchTargets::SplitId).big_integer().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_bank_log_match_targets_match")
                            .from(BankLogMatchTargets::Table, BankLogMatchTargets::MatchId)
                            .to(BankLogMatches::Table, BankLogMatches::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_bank_log_match_targets_transaction")
                            .from(BankLogMatchTargets::Table, BankLogMatchTargets::TransactionId)
                            .to(Transactions::Table, Transactions::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_bank_log_match_targets_split")
                            .from(BankLogMatchTargets::Table, BankLogMatchTargets::SplitId)
                            .to(Splits::Table, Splits::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_bank_log_match_targets_match")
                    .table(BankLogMatchTargets::Table)
                    .col(BankLogMatchTargets::MatchId)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::DiscordBankLogChannelId)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::BankLogSellerAccounts)
                            .string()
                            .not_null()
                            .default(""),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::BankLogRemindedOn)
                            .string_len(10)
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::BankLogReminderError)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        seed_permissions(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::BankLogReminderError,
            GuildSettings::BankLogRemindedOn,
            GuildSettings::BankLogSellerAccounts,
            GuildSettings::DiscordBankLogChannelId,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        for table in [
            Alias::new("bank_log_match_targets"),
            Alias::new("bank_log_match_entries"),
            Alias::new("bank_log_matches"),
            Alias::new("bank_log_entries"),
        ] {
            manager
                .drop_table(Table::drop().table(table).if_exists().to_owned())
                .await?;
        }
        Ok(())
    }
}

/// Grants the two new permissions to the built-in officer-level role names, like the siphoned
/// and warns seeds do.
async fn seed_permissions(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
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
        if !matches!(
            normalized.as_str(),
            "officer" | "moderator" | "admin" | "superadmin" | "super admin"
        ) {
            continue;
        }
        for permission in ["bank.log.view", "bank.log.manage"] {
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

#[derive(DeriveIden)]
enum BankLogEntries {
    Table,
    Id,
    OccurredAt,
    PlayerName,
    PlayerKey,
    Reason,
    Amount,
    Occurrence,
    Category,
    Status,
    Note,
    ExplainedAt,
    ExplainedBy,
    BatchId,
    ImportedAt,
    ImportedBy,
    CreatedTransactionId,
}

#[derive(DeriveIden)]
enum BankLogMatches {
    Table,
    Id,
    Kind,
    Confirmed,
    CreatedAt,
    CreatedBy,
    ConfirmedAt,
    ConfirmedBy,
}

#[derive(DeriveIden)]
enum BankLogMatchEntries {
    Table,
    Id,
    MatchId,
    EntryId,
}

#[derive(DeriveIden)]
enum BankLogMatchTargets {
    Table,
    Id,
    MatchId,
    TransactionId,
    SplitId,
}

#[derive(DeriveIden)]
enum Transactions {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Splits {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordBankLogChannelId,
    BankLogSellerAccounts,
    BankLogRemindedOn,
    BankLogReminderError,
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
