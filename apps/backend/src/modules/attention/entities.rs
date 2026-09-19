//! `SeaORM` entity for `attention_findings`.
//!
//! A single table, grouped as an inner `attention_finding` module the same
//! way `modules::economy::entities`'s single-table `battle_loss_estimate`
//! does — no cross-entity relations to wire. See
//! `m20260908_000010_create_attention_findings` for the full
//! replace-wholesale-per-rule and polymorphic-subject rationale.

pub mod attention_finding {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    /// One currently-true attention signal, as produced by exactly one
    /// `attention::rules` function. Replaced wholesale per `rule_key` (and,
    /// for a per-subject rule, per `rule_key` across every subject) on every
    /// recompute — see the migration's doc comment for why this is not an
    /// immutable-identity table.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "attention_findings")]
    pub struct Model {
        /// Surrogate primary key.
        #[sea_orm(primary_key)]
        pub id: i64,
        /// Stable rule identifier, e.g. `"win_rate_drop"`. Matches one of
        /// `attention::rules`'s function names.
        pub rule_key: String,
        /// The version of the rule's own definition (threshold, formula)
        /// that produced this row, so a later change to the rule does not
        /// silently reinterpret an old finding.
        pub rule_version: i32,
        /// `"high"` / `"medium"` / `"info"`. Plain text, not an
        /// enum/check constraint, matching the established idiom elsewhere
        /// in this codebase for small stable vocabularies.
        pub severity: String,
        /// What this finding is about: `"guild"` for a guild-wide rule
        /// (`subject_id` is then `NULL`), or `"enemy_guild"` for a
        /// per-enemy-guild rule such as `stale_intel` (`subject_id` is then
        /// that `enemy_guilds.id`).
        pub subject_type: String,
        /// Polymorphic reference, meaning depends on `subject_type`.
        /// Deliberately unconstrained (no foreign key), the same idiom
        /// already used for the upstream-`battle_id` columns elsewhere in
        /// this codebase, but for a different reason here: this column can
        /// point at different tables depending on `subject_type`, so a
        /// single FK could never express it anyway.
        pub subject_id: Option<i64>,
        /// Start of the window this finding was evaluated over.
        pub period_start: DateTimeWithTimeZone,
        /// End of the window this finding was evaluated over.
        pub period_end: DateTimeWithTimeZone,
        /// The rule's primary metric, in whatever unit that rule uses
        /// (percentage points, silver, item power, days) — see
        /// `attention::rules`'s per-rule doc comments.
        pub metric_value: f64,
        /// The comparison value for a period-over-period rule (e.g. the
        /// previous period's win rate). `NULL` for a threshold-only rule,
        /// which has no baseline to report.
        pub baseline_value: Option<f64>,
        /// The sample size the rule's minimum-sample gate was evaluated
        /// against (fights, item stacks, distinct battles — see the
        /// specific rule). Exists so a reader can judge confidence without
        /// re-deriving it from `evidence_json`.
        pub sample_size: i32,
        /// The full numeric evidence bundle behind this finding, as a JSON
        /// object. Numbers and identifiers only — never generated text (see
        /// the migration's doc comment).
        pub evidence_json: String,
        /// When this specific finding was computed. The reproducibility
        /// anchor, mirroring the role `computed_at` plays for `fight_stats`.
        pub computed_at: DateTimeWithTimeZone,
        /// Row creation time.
        pub created_at: DateTimeWithTimeZone,
        /// Last time this row was replaced by a recompute.
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
