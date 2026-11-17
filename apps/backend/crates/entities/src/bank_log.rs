//! Sea-ORM entities for the Albion guild bank log and its reconciliation with the Manager.
//!
//! See the `m20261117_000002_create_bank_log` migration for the row identity rule.

/// One line of the in-game guild bank silver log.
pub mod entry {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "bank_log_entries")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        /// In-game time of the movement, UTC, minute precision.
        pub occurred_at: DateTimeWithTimeZone,
        /// Player name as the export shows it (for withdrawals: the paying officer).
        pub player_name: String,
        /// Lowercased player name, part of the row identity.
        pub player_key: String,
        /// Raw Albion reason (`Deposit`, `Withdrawal`, `Purchase of guild vault ...`).
        pub reason: String,
        /// Signed silver amount: deposits positive, withdrawals and expenses negative.
        pub amount: Decimal,
        /// 1-based index among identical lines of the same export.
        pub occurrence: i32,
        /// `payout`, `bags`, `loot_sale`, `guild_expense`, `donation` or `other`.
        pub category: String,
        /// `unmatched`, `suggested`, `matched` or `explained`, kept in sync by the service.
        pub status: String,
        /// Officer note; required to mark a row explained.
        pub note: Option<String>,
        pub explained_at: Option<DateTimeWithTimeZone>,
        pub explained_by: Option<i64>,
        /// Import that first stored this row.
        pub batch_id: String,
        pub imported_at: DateTimeWithTimeZone,
        pub imported_by: Option<i64>,
        /// Bank transaction created from this row; unique, kept after the transaction is deleted.
        pub created_transaction_id: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A link between log rows and Manager records. Unconfirmed links are suggestions.
pub mod link {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "bank_log_matches")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        /// `payout`, `bags`, `loot_sale` or `manual`.
        pub kind: String,
        pub confirmed: bool,
        pub created_at: DateTimeWithTimeZone,
        pub created_by: Option<i64>,
        pub confirmed_at: Option<DateTimeWithTimeZone>,
        pub confirmed_by: Option<i64>,
        /// How likely an automatic suggestion is, 0-100. `None` for manual links.
        pub score: Option<i32>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A log row taking part in a link.
pub mod link_entry {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "bank_log_match_entries")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub match_id: i64,
        pub entry_id: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// A Manager record taking part in a link: a bank transaction or a split.
pub mod link_target {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
    #[sea_orm(table_name = "bank_log_match_targets")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub match_id: i64,
        /// Set to `NULL` when the transaction is deleted.
        pub transaction_id: Option<i64>,
        /// Set to `NULL` when the split is deleted.
        pub split_id: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
