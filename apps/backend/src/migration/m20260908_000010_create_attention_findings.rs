//! Creates `attention_findings`: the persisted output of the deterministic
//! attention-signal rules in `attention::rules`.
//!
//! # One table, many rules, replaced wholesale per rule on every recompute
//!
//! Like `battle_loss_estimates` and `fight_stats` (see those migrations'
//! doc comments for the full rationale this one shares), this is not an
//! immutable-identity table: a finding is "does this rule currently hold",
//! not a historical fact worth preserving once it stops holding. Every
//! recompute (`attention::writer::recompute_attention_findings`) deletes
//! every row for a given `rule_key` (and, for a per-subject rule such as
//! `stale_intel`, every row for that `rule_key` across every subject) and
//! re-inserts whatever currently qualifies. A finding that stops being true
//! — win rate recovered, intel got refreshed — simply disappears on the next
//! recompute; nothing here is a ticket or an audit log of past findings.
//!
//! # `subject_type`/`subject_id`: guild-wide vs per-entity findings
//!
//! Some rules (`win_rate_drop`, `trade_worsening`, `ip_deficit`,
//! `unpriced_losses`, `attribution_gap`) evaluate the whole guild and
//! produce at most one row, with `subject_type = "guild"` and
//! `subject_id = NULL`. Others (`stale_intel`) evaluate one entity at a
//! time — one enemy guild — and can produce many rows, one per qualifying
//! `enemy_guilds.id`, with `subject_type = "enemy_guild"`. No foreign key
//! on `subject_id`: it is deliberately polymorphic across whatever
//! `subject_type` says it points to, matching the established idiom in this
//! codebase of leaving cross-concept references unconstrained rather than
//! modelling a table-per-subject-type join.
//!
//! # No generated text
//!
//! `evidence_json` holds only numbers and identifiers a rule's own
//! evaluation produced — never natural-language commentary. Rendering a
//! human-readable sentence from `rule_key` + `evidence_json` is a read-side
//! concern (the API consumer's job), consistent with plan §7's "nessun testo
//! generato" constraint.
//!
//! `metric_value`/`baseline_value`/`sample_size` are pulled out of
//! `evidence_json` as their own columns (rather than left buried in JSON)
//! specifically so a list endpoint can sort/filter on them without parsing
//! JSON — `baseline_value` is nullable because threshold-only rules
//! (`ip_deficit`, `unpriced_losses`, `attribution_gap`, `stale_intel`) have
//! no period-over-period comparison to report.
//!
//! `rule_version` exists so a future change to a rule's own definition
//! (threshold, formula) does not silently reinterpret a row computed under
//! the old definition — a row always carries the version of the rule that
//! produced it.
//!
//! This migration is purely additive: it does not touch any existing table.

use sea_orm_migration::prelude::*;

/// Migration step creating `attention_findings`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(AttentionFindings::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(AttentionFindings::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::RuleKey)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::RuleVersion)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::Severity)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::SubjectType)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(AttentionFindings::SubjectId).big_integer())
                    .col(
                        ColumnDef::new(AttentionFindings::PeriodStart)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::PeriodEnd)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::MetricValue)
                            .double()
                            .not_null(),
                    )
                    .col(ColumnDef::new(AttentionFindings::BaselineValue).double())
                    .col(
                        ColumnDef::new(AttentionFindings::SampleSize)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::EvidenceJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::ComputedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(AttentionFindings::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_attention_findings_rule_key")
                    .table(AttentionFindings::Table)
                    .col(AttentionFindings::RuleKey)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_attention_findings_subject")
                    .table(AttentionFindings::Table)
                    .col(AttentionFindings::SubjectType)
                    .col(AttentionFindings::SubjectId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(AttentionFindings::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum AttentionFindings {
    Table,
    Id,
    RuleKey,
    RuleVersion,
    Severity,
    SubjectType,
    SubjectId,
    PeriodStart,
    PeriodEnd,
    MetricValue,
    BaselineValue,
    SampleSize,
    EvidenceJson,
    ComputedAt,
    CreatedAt,
    UpdatedAt,
}
