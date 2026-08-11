//! Sea-ORM entity for the `transactions` table (the Guild Bank ledger).

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "transactions")]
pub struct Model {
    /// The unique primary key of the transaction.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// The user who paid out the amount (the officer who accepted the withdrawal request).
    /// `None` until the withdrawal is accepted (the Guild Bank is the notional source until then).
    pub from_user_id: Option<i64>,
    /// The user who is owed / receives the amount.
    pub to_user_id: i64,
    /// The amount of the transaction, always positive; direction is encoded by from/to.
    pub amount: Decimal,
    /// The lifecycle status of the transaction: `"pending"`, `"requested"`, `"rejected"`, or `"withdrawn"`.
    pub status: String,
    /// The kind of transaction, e.g. `"split_credit"`.
    #[sea_orm(column_name = "type")]
    pub r#type: String,
    /// The split that generated this transaction, if any.
    pub split_id: Option<i64>,
    /// The timestamp when the transaction was created.
    pub created_at: DateTimeWithTimeZone,
    /// The timestamp when the recipient requested withdrawal, if they have.
    pub requested_at: Option<DateTimeWithTimeZone>,
    /// The timestamp when an officer accepted the withdrawal (paid it out), if they have.
    pub withdrawn_at: Option<DateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    FromUser,
    ToUser,
    Split,
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::FromUser => Entity::belongs_to(crate::modules::users::entities::Entity)
                .from(Column::FromUserId)
                .to(crate::modules::users::entities::Column::Id)
                .into(),
            Self::ToUser => Entity::belongs_to(crate::modules::users::entities::Entity)
                .from(Column::ToUserId)
                .to(crate::modules::users::entities::Column::Id)
                .into(),
            Self::Split => Entity::belongs_to(crate::modules::splits::entities::split::Entity)
                .from(Column::SplitId)
                .to(crate::modules::splits::entities::split::Column::Id)
                .into(),
        }
    }
}

impl ActiveModelBehavior for ActiveModel {}
