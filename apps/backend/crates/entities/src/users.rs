//! Sea-ORM entity for the `users` table.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "users")]
pub struct Model {
    /// The unique primary key of the user.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// The username of the user.
    pub username: String,
    /// The unique email address of the user.
    #[sea_orm(unique)]
    pub email: String,
    /// The system authorization role of the user.
    pub role: String,
    /// The Discord snowflake ID this user last logged in with, if any. Bridges to
    /// `albion_links.discord_id` so a linked Albion Online character name can be resolved
    /// back to this user.
    #[sea_orm(unique)]
    pub discord_id: Option<String>,
    /// The timestamp when the user was created.
    pub created_at: DateTimeWithTimeZone,
    /// Present in this tenant's Discord (or proven by an interaction). The only deactivation
    /// flag: `false` means soft-deactivated (`left_reason` says why). Ex-members keep their
    /// history.
    pub active: bool,
    /// When the row was last deactivated. Cleared on reactivation.
    pub left_at: Option<DateTimeWithTimeZone>,
    /// Why the row is inactive: `left`, `absent_on_check`, `reconcile` or `not_joined` (created by
    /// cross-tenant propagation and never seen in this Discord).
    pub left_reason: Option<String>,
    /// JSON array of Discord role snowflakes, sorted and unique. Stored as text for SQLite.
    pub discord_role_ids: String,
    /// Last time the role snapshot was confirmed against Discord. `None` means unknown.
    pub roles_checked_at: Option<DateTimeWithTimeZone>,
    /// `occurred_at` of the last applied membership event (ordering guard).
    pub member_event_at: Option<DateTimeWithTimeZone>,
    /// How the row was first created: `web`, `bot`, `gateway`, `reconcile`, `admin`,
    /// `alliance_sync`, `event_sync`, or `sync` for rows created before this was recorded.
    pub provisioned_via: String,
    /// Self-service link/unlink cooldown anchor.
    pub last_link_change_at: Option<DateTimeWithTimeZone>,
    /// When an officer blocked this member from the manager. `None` means not blocked. A blocked
    /// member cannot log in or call any authenticated endpoint (the Discord membership is
    /// untouched).
    pub blocked_at: Option<DateTimeWithTimeZone>,
    /// `users.id` of the officer who blocked the member. No foreign key, so it can outlive them.
    pub blocked_by: Option<i64>,
    /// Optional note the officer gave when blocking. Visible to `roles.manage` holders only.
    pub blocked_reason: Option<String>,
}

#[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
