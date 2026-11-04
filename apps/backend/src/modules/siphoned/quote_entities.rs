//! Short-lived, single-use settlement quotes.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "siphoned_settlement_quotes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "String(StringLen::N(36))")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    pub player_name: String,
    pub user_id: i64,
    pub actor_user_id: i64,
    pub debt: Decimal,
    pub unit_price: Decimal,
    pub total: Decimal,
    pub expires_at: DateTimeWithTimeZone,
    pub created_at: DateTimeWithTimeZone,
    pub consumed_at: Option<DateTimeWithTimeZone>,
    pub siphoned_entry_id: Option<i64>,
    pub transaction_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
